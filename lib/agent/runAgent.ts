import type {
  AgentInput,
  AgentMemory,
  AgentOutput,
  AgentState,
  CandidateMemory,
  NextMessage,
  Personality,
  Plan,
  Reasoning,
} from "./types";
import { META_MODEL, CAPS, channelLimit } from "./config";
import { hashContext, getPersonality, deriveVoiceProfile, fallbackPersonality } from "./persona";
import {
  emptyCandidateMemory,
  emptyAgentMemory,
  applyMemoryOps,
  updateTemperature,
  deriveStyleAdjustments,
} from "./memory";
import { runReason, cheapDetectLang } from "./reason";
import { applyInvariants, candidateAskedForCall } from "./invariants";
import { buildGroundingPack, buildForbiddenList } from "./grounding";
import {
  runWrite,
  runCompress,
  truncateToSentence,
  fallbackMessage,
  fallbackLang,
  type WriteArgs,
} from "./write";
import {
  deterministicChecks,
  llmVerify,
  needsLlmVerify,
  containsTerm,
  hasSchedulingLanguage,
  type DeterministicCtx,
} from "./verify";
import { defaultPlan } from "./state";

function pushUnique(arr: string[], items: string[], cap = 40): string[] {
  const out = [...arr];
  for (const it of items) {
    const t = it.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(-cap);
}

// Découpe en phrases (., ?, !) et ne garde que les questions complètes, normalisées.
function extractQuestions(body: string): string[] {
  return body
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith("?"))
    .map((s) => s.slice(0, 200));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fallback déterministe TOUJOURS vérifié : si le template viole un interdit
// (dontSay/sujet banni), on l'assainit, puis on tombe sur un message ultra-générique.
// Garantit : jamais de message non vérifié qui sort, même par la voie de repli.
function safeFallback(args: WriteArgs, vctx: DeterministicCtx): NextMessage {
  let msg = fallbackMessage(args);
  if (deterministicChecks(msg, vctx).length === 0) return msg;

  const strip = (s: string) =>
    vctx.forbidden.dontSay.reduce(
      (acc, t) => (t ? acc.replace(new RegExp(escapeRegex(t), "gi"), "").replace(/\s{2,}/g, " ") : acc),
      s,
    );
  msg = { ...msg, body: strip(msg.body), subject: msg.subject ? strip(msg.subject) : msg.subject };
  if (deterministicChecks(msg, vctx).length === 0) return msg;

  const fr = fallbackLang(args.voiceProfile.language) === "fr";
  const name =
    args.pack.fields.find((f) => f.path === "identity.name")?.value ?? (fr ? "notre équipe" : "our team");
  return {
    channelHint: vctx.channelHint,
    ...(vctx.channelHint === "email"
      ? { subject: fr ? "Prise de contact" : "Quick note" }
      : {}),
    body: fr
      ? `Un mot rapide de la part de ${name}. Pouvons-nous en échanger ?`
      : `A quick note from ${name}. Could we connect about it?`,
  };
}

// Dépassement de longueur : on NE tombe PAS en template générique. On tente une
// passe de COMPRESSION dédiée (garde le fond), puis une troncature propre à la
// phrase en dernier recours. Le message d'origine a déjà passé tous les autres
// checks (longueur seule) → la troncature ne peut pas réintroduire d'interdit.
async function enforceLength(
  message: NextMessage,
  vctx: DeterministicCtx,
): Promise<{ message: NextMessage; calls: number }> {
  if (message.body.length <= vctx.bodyLimit) return { message, calls: 0 };

  const c = await runCompress({
    subject: message.subject,
    body: message.body,
    limit: vctx.bodyLimit,
    voiceProfile: vctx.voiceProfile,
  });
  if (c.message) {
    const candidate: NextMessage = {
      channelHint: vctx.channelHint,
      subject: c.message.subject ?? message.subject,
      body: c.message.body,
    };
    if (deterministicChecks(candidate, vctx).length === 0) {
      return { message: candidate, calls: c.calls };
    }
  }
  // Dernier recours déterministe : troncature propre du message d'origine (conforme sauf longueur).
  return {
    message: { ...message, body: truncateToSentence(message.body, vctx.bodyLimit) },
    calls: c.calls,
  };
}

// L'interface PUBLIQUE du moteur. NE THROW JAMAIS : en cas d'erreur, renvoie un
// AgentOutput utilisable (message fallback) avec meta.ok=false et meta.errors rempli.
export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const errors: string[] = [];
  let calls = 0;

  try {
    const ctx = input.companyContext;
    const personaKey = hashContext(ctx);
    const prior = input.priorState ?? null;

    // ── Personnalité ──
    // Le persona ne se régénère QUE si le contexte a changé (personaKey différent).
    // La mémoire/le plan/les compteurs se reportent dès qu'un priorState existe
    // (même conversation), indépendamment du persona.
    let personality: Personality;
    if (prior && prior.personaKey === personaKey) {
      personality = prior.personality;
    } else {
      const p = await getPersonality(ctx, personaKey);
      calls += p.calls;
      personality = p.personality;
    }

    // ── État de départ : report depuis priorState s'il existe ──
    // On NE reporte la mémoire QUE si le contexte n'a pas changé. Si le contexte
    // change en cours de route (personaKey différent), c'est une autre conversation :
    // on repart de zéro pour ne pas contaminer la nouvelle entreprise avec l'ancienne.
    const contextChanged = !!prior && prior.personaKey !== personaKey;
    const carry = prior && !contextChanged;
    if (contextChanged) {
      errors.push("contexte changé (personaKey différent) → mémoire réinitialisée");
    }

    let candidateMemory: CandidateMemory = carry
      ? structuredClone(prior!.candidateMemory)
      : emptyCandidateMemory();
    let agentMemory: AgentMemory = carry
      ? structuredClone(prior!.agentMemory)
      : emptyAgentMemory();
    const plan: Plan = carry ? prior!.plan : defaultPlan(input.intent);
    const counters = carry
      ? { ...prior!.counters }
      : { messagesSent: 0, revisions: 0, objectionsRaised: 0, objectionsResolved: 0 };

    const turn = counters.messagesSent + 1;

    // Historique présent ? (≥1 message agent déjà envoyé : conversation ou priorState)
    const hasHistory =
      counters.messagesSent >= 1 || input.conversation.some((m) => m.role === "agent");

    // ── 1) REASON (1 appel LLM, modèle fort) ──
    const reasonRes = await runReason(input, candidateMemory, agentMemory);
    calls += reasonRes.calls;
    if (!reasonRes.ok) errors.push(`reason: ${reasonRes.error ?? "échec"} (fallback déterministe)`);

    // ── LANGUE ACTIVE : suit la conversation, pas voice.language. ──
    // S'il y a un message candidat → langue détectée par REASON ; sinon (1er message
    // sortant) → langue de la voix configurée.
    const hasCandidateMsg =
      !!input.incomingCandidateReply?.trim() ||
      input.conversation.some((m) => m.role === "candidate");
    const detected = reasonRes.reason.detectedLanguage?.trim();
    const activeLanguage = hasCandidateMsg && detected ? detected : ctx.voice.language;

    // ── Application des MemoryOps (state) — AVANT les invariants, pour que ceux-ci
    // voient la mémoire FRAÎCHE (incl. une objection levée à ce tour). ──
    const applied = applyMemoryOps(candidateMemory, reasonRes.reason.memoryOps, turn);
    candidateMemory = applied.memory;
    candidateMemory.temperature = updateTemperature(candidateMemory, input.incomingCandidateReply);

    // ── 2) Ancrage + garde-fous (déterministe, 0 LLM) ──
    const inv = applyInvariants(reasonRes.reason, {
      turn,
      incomingReply: input.incomingCandidateReply,
      mem: candidateMemory,
      agentMem: agentMemory,
      hasHistory,
      priorStage: prior?.plan.currentStage,
    });
    const reason = inv.reason;

    // ── voiceProfile (langue = ACTIVE LANGUAGE) + ancrage + liste d'interdits ──
    const styleAdjustments = deriveStyleAdjustments(candidateMemory);
    const voiceProfile = { ...deriveVoiceProfile(ctx, styleAdjustments), language: activeLanguage };
    const pack = buildGroundingPack(ctx, reason.groundingFields);
    const forbidden = buildForbiddenList(ctx, candidateMemory, agentMemory);

    // ── 3) WRITE (1 appel LLM, modèle fort) ──
    // Limite de longueur DURE selon canal + type (hook = 1er message vs answer).
    const isHook = !hasHistory;
    const bodyLimit = channelLimit(reason.channelHint, isHook);

    // Stage-gate du SCHEDULING : autorisé seulement en propose_call/confirm_logistics,
    // ou si le candidat a explicitement demandé un appel à ce tour.
    const schedulingAllowed =
      reason.stage === "propose_call" ||
      reason.stage === "confirm_logistics" ||
      candidateAskedForCall(input.incomingCandidateReply);

    // mustNotDo passé au writer = directives de REASON + répétitions promises évitées.
    const mustNotDo = [...reason.mustNotDo, ...reason.avoidedRepetition];

    const writeArgs: WriteArgs = {
      nextObjective: reason.nextObjective,
      decision: reason.decision,
      mustDo: reason.mustDo,
      mustNotDo,
      schedulingAllowed,
      stage: reason.stage,
      channelHint: reason.channelHint,
      pack,
      voiceProfile,
      forbidden,
      persona: personality.persona,
      candidateName: input.candidate?.name,
      bodyLimit,
    };

    // Contexte de vérification, partagé par VERIFY et par le fallback (qui est
    // lui aussi vérifié+assaini : jamais de message non vérifié qui sort).
    const vctx: DeterministicCtx = {
      forbidden,
      voiceProfile,
      channelHint: reason.channelHint,
      bodyLimit,
      schedulingAllowed,
    };

    let message: NextMessage;
    let revisions = 0;
    const writeRes = await runWrite(writeArgs);
    calls += writeRes.calls;

    if (!writeRes.ok || !writeRes.message) {
      errors.push(`write: ${writeRes.error ?? "échec"} → fallback déterministe`);
      message = safeFallback(writeArgs, vctx);
    } else {
      message = writeRes.message;
      // ── 4) VERIFY — DÉTERMINISTE par défaut. L'appel LLM (3e appel) n'est payé
      //    QUE si c'est ambigu (recoupement lexical avec un sujet banni / une info
      //    connue). Tour de réaction normal → 2 appels (reason + write). ──
      const isLengthViolation = (v: string) => v.startsWith("Body trop long");
      // L'adhérence (le message a-t-il EXÉCUTÉ la décision ?) se vérifie sur un tour
      // de réaction (historique présent) ; le 1er message à froid n'a rien à adhérer.
      const adherenceCtx = {
        decision: reason.decision,
        mustDo: reason.mustDo,
        mustNotDo,
        avoidedRepetition: reason.avoidedRepetition,
      };
      while (true) {
        let violations = deterministicChecks(message, vctx);
        if (violations.length === 0 && (hasHistory || needsLlmVerify(message, forbidden))) {
          const lv = await llmVerify(message, forbidden, hasHistory ? adherenceCtx : undefined);
          calls += lv.calls;
          if (!lv.ok) errors.push("verify(llm): indisponible (laissé passer)");
          if (!lv.pass) violations = lv.violations;
        }
        if (violations.length === 0) break; // message vérifié → on l'expédie

        // LONGUEUR SEULE → compression dédiée puis troncature propre (PAS de générique).
        if (violations.every(isLengthViolation)) {
          const enf = await enforceLength(message, vctx);
          calls += enf.calls;
          message = enf.message; // garanti ≤ limite, conforme aux autres checks
          break;
        }

        // Autres violations (placeholders, dontSay, sujet banni, redite) → 1 révision.
        if (revisions >= CAPS.maxRevisions) {
          errors.push(`verify: échec après révision (${violations.join(" | ")}) → fallback`);
          message = safeFallback(writeArgs, vctx);
          break;
        }
        revisions++;
        const rw = await runWrite({ ...writeArgs, critique: violations.join("\n") });
        calls += rw.calls;
        if (!rw.ok || !rw.message) {
          errors.push(`révision write: ${rw.error ?? "échec"} → fallback`);
          message = safeFallback(writeArgs, vctx);
          break;
        }
        message = rw.message;
      }
    }

    // ── 5) STATE UPDATE (déterministe) ──
    const newQuestions = extractQuestions(message.body);
    // Bonus : on journalise les MOVES réellement faits (mustDo exécutés + excuses/échange
    // détectés dans le body) → ils deviennent des interdits durs au tour suivant.
    const moves = detectMoves(message.body);
    const isProposal =
      reason.stage === "propose_call" ||
      reason.stage === "confirm_logistics" ||
      hasSchedulingLanguage(message.body);
    agentMemory = {
      pointsMade: pushUnique(agentMemory.pointsMade, [...reason.mustDo, ...moves, reason.nextObjective]),
      questionsAsked: pushUnique(agentMemory.questionsAsked, newQuestions),
      proposalsMade: isProposal
        ? pushUnique(agentMemory.proposalsMade, [reason.nextObjective])
        : agentMemory.proposalsMade,
    };

    const newCounters = {
      messagesSent: counters.messagesSent + 1,
      revisions: counters.revisions + revisions,
      objectionsRaised: counters.objectionsRaised + applied.objectionsRaised,
      objectionsResolved: counters.objectionsResolved + applied.objectionsResolved,
    };

    const updatedPersonality: Personality = { ...personality, voiceProfile };
    plan.currentStage = reason.stage;

    const state: AgentState = {
      personaKey,
      personality: updatedPersonality,
      plan,
      candidateMemory,
      agentMemory,
      counters: newCounters,
    };

    // ── Trace MESURÉE sur le message final (jamais juste déclarée par REASON) ──
    const reasoning: Reasoning = {
      candidateSignals: reason.signals,
      decision: reason.decision,
      groundingUsed: pack.used,
      constraintsRespected: measureConstraints(message, vctx, inv.notes),
      avoidedRepetition: measureAvoided(message, forbidden),
      memoryUpdates: applied.summary,
    };

    return {
      personality: updatedPersonality,
      plan,
      reasoning,
      nextMessage: message,
      state,
      meta: { ok: errors.length === 0, errors, llmCallsFired: calls, model: META_MODEL },
    };
  } catch (e) {
    // Filet ultime : never-throw.
    errors.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    return catastrophicFallback(input, errors, calls);
  }
}

// Trace MESURÉE sur le message FINAL (pas déclarée par REASON) : on n'affiche un ✓
// que si le message réel le confirme. Une trace qui ment est pire que pas de trace.
function measureAvoided(msg: NextMessage, forbidden: ReturnType<typeof buildForbiddenList>): string[] {
  const lower = `${msg.subject ?? ""}\n${msg.body}`.toLowerCase();
  const out: string[] = [];
  for (const t of forbidden.bannedTopics) if (!containsTerm(lower, t)) out.push(`n'a pas reproposé : « ${t} »`);
  for (const f of forbidden.knownFacts) if (!containsTerm(lower, f)) out.push(`n'a pas re-demandé : « ${f} »`);
  for (const p of forbidden.pointsMade) if (!containsTerm(lower, p)) out.push(`n'a pas répété : « ${p} »`);
  return out.slice(0, 8);
}

function measureConstraints(msg: NextMessage, vctx: DeterministicCtx, invNotes: string[]): string[] {
  const haystack = `${msg.subject ?? ""}\n${msg.body}`;
  const lower = haystack.toLowerCase();
  const out = [...invNotes];
  if (vctx.forbidden.dontSay.length && vctx.forbidden.dontSay.every((t) => !containsTerm(lower, t))) {
    out.push("aucun terme proscrit (dontSay) utilisé");
  }
  if (!vctx.schedulingAllowed && !hasSchedulingLanguage(haystack)) {
    out.push("pas de proposition d'appel/créneau (hors-stage)");
  }
  if (msg.body.length <= vctx.bodyLimit) out.push(`longueur respectée (${msg.body.length} ≤ ${vctx.bodyLimit})`);
  for (const c of vctx.forbidden.constraints) out.push(`respecte la contrainte active : « ${c} »`);
  return out.slice(0, 10);
}

// Bonus : journalise les vrais MOVES du message (excuses, proposition d'échange)
// pour qu'ils ne soient pas répétés au tour suivant.
function detectMoves(body: string): string[] {
  const moves: string[] = [];
  if (/\b(d[ée]sol[ée]|navr[ée]|excuse|pardon|sorry|apolog)/i.test(body)) {
    moves.push("a présenté des excuses");
  }
  if (hasSchedulingLanguage(body)) moves.push("a proposé un échange/créneau");
  return moves;
}

function catastrophicFallback(input: AgentInput, errors: string[], calls: number): AgentOutput {
  const ctx = input.companyContext;
  const voiceProfile = deriveVoiceProfile(ctx);
  const personality = fallbackPersonality(ctx, voiceProfile);
  const plan = input.priorState?.plan ?? defaultPlan(input.intent);
  const name = ctx?.identity?.name ?? "our team";
  const lastCandidate =
    input.incomingCandidateReply ??
    [...(input.conversation ?? [])].reverse().find((m) => m.role === "candidate")?.content ??
    "";
  const fr = (cheapDetectLang(lastCandidate) || ctx?.voice?.language || "en").match(/^fr|fran/i);
  const message: NextMessage = {
    channelHint: "email",
    subject: fr ? `Un mot de ${name}` : `A note from ${name}`,
    body: fr
      ? `Bonjour, je vous contacte de la part de ${name}. Seriez-vous ouvert à un court échange ?`
      : `Hi, I'm reaching out from ${name}. Would you be open to a short chat?`,
  };
  const state: AgentState = input.priorState ?? {
    personaKey: ctx ? hashContext(ctx) : "persona_unknown",
    personality,
    plan,
    candidateMemory: emptyCandidateMemory(),
    agentMemory: emptyAgentMemory(),
    counters: { messagesSent: 1, revisions: 0, objectionsRaised: 0, objectionsResolved: 0 },
  };
  return {
    personality,
    plan,
    reasoning: {
      decision: "Erreur fatale — message de repli sûr.",
      groundingUsed: [`identity.name = ${name}`],
      constraintsRespected: [],
      avoidedRepetition: [],
      memoryUpdates: [],
    },
    nextMessage: message,
    state,
    meta: { ok: false, errors, llmCallsFired: calls, model: META_MODEL },
  };
}
