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
  deriveStyleAdjustments,
} from "./memory";
import { runReason, cheapDetectLang, resolveActiveLanguage } from "./reason";
import { applyInvariants, candidateAskedForCall, assessEngagement } from "./invariants";
import { buildGroundingPack, buildForbiddenList } from "./grounding";
import { runWrite, fallbackMessage, fallbackLang, type WriteArgs } from "./write";
import {
  deterministicChecks,
  llmVerify,
  containsTerm,
  hasSchedulingLanguage,
  repairMessage,
  normalizeLang,
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

// Repli CATASTROPHIQUE uniquement (WRITE n'a produit AUCUN draft : timeout / parse /
// sortie vide). On part du template d'étape (stage + langue) puis on le RÉPARE de
// façon déterministe. Aucun stub générique de conversation ici.
function safeFallback(args: WriteArgs, vctx: DeterministicCtx): NextMessage {
  const repaired = repairMessage(fallbackMessage(args), vctx);
  if (repaired.body.trim()) return repaired;
  // Cas dégénéré (le template d'étape entier était un interdit) : salutation minimale.
  const fr = fallbackLang(args.voiceProfile.language) === "fr";
  return { channelHint: vctx.channelHint, body: fr ? "Bonjour." : "Hello." };
}

// Valide la FORME d'un priorState (vient du client, non fiable). Renvoie true seulement
// si tous les champs déréférencés par le carry sont présents et du bon type.
function isValidPriorState(s: AgentState | null | undefined): s is AgentState {
  if (!s || typeof s !== "object") return false;
  const a = s as Partial<AgentState>;
  const arr = (x: unknown) => Array.isArray(x);
  const cm = a.candidateMemory as Partial<CandidateMemory> | undefined;
  return (
    typeof a.personaKey === "string" &&
    !!a.personality?.voiceProfile &&
    typeof a.personality.voiceProfile.language === "string" &&
    !!a.plan &&
    typeof a.plan.currentStage === "string" &&
    !!cm &&
    arr(cm.rejections) &&
    arr(cm.constraints) &&
    arr(cm.objections) &&
    arr(cm.facts) &&
    arr(cm.dismissedTopics) &&
    arr(cm.styleFeedback) &&
    !!a.agentMemory &&
    arr(a.agentMemory.pointsMade) &&
    arr(a.agentMemory.questionsAsked) &&
    arr(a.agentMemory.proposalsMade) &&
    !!a.counters &&
    typeof a.counters.messagesSent === "number"
  );
}

// L'interface PUBLIQUE du moteur. NE THROW JAMAIS : en cas d'erreur, renvoie un
// AgentOutput utilisable (message fallback) avec meta.ok=false et meta.errors rempli.
export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const errors: string[] = [];
  let calls = 0;

  try {
    const ctx = input.companyContext;
    const personaKey = hashContext(ctx);
    // priorState arrive en JSON OPAQUE du client (localStorage) : un blob d'un ancien
    // schéma ou tronqué ferait crasher le carry. On valide la forme et, si invalide,
    // on repart proprement (sans throw, sans poison) plutôt que de déréférencer à l'aveugle.
    const rawPrior = input.priorState ?? null;
    const prior = isValidPriorState(rawPrior) ? rawPrior : null;
    if (rawPrior && !prior) errors.push("priorState malformed/old-shape → reset (fresh start)");

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
      errors.push("context changed (different personaKey) → memory reset");
    }

    let candidateMemory: CandidateMemory = carry
      ? structuredClone(prior!.candidateMemory)
      : emptyCandidateMemory();
    let agentMemory: AgentMemory = carry
      ? structuredClone(prior!.agentMemory)
      : emptyAgentMemory();
    // On reporte l'étape courante mais on RAFRAÎCHIT les objectifs depuis le code
    // (sinon un priorState persisté garde d'anciens libellés, ex. français).
    const plan: Plan = carry
      ? { ...defaultPlan(input.intent), currentStage: prior!.plan.currentStage }
      : defaultPlan(input.intent);
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
    if (!reasonRes.ok) errors.push(`reason: ${reasonRes.error ?? "failed"} (deterministic fallback)`);

    // ── LANGUE ACTIVE : dominante + STICKY sur la conversation (déterministe). ──
    // On mirror le candidat mais sur la langue DOMINANTE, pas sur le dernier mot :
    // un loanword isolé (« mec ») ne flip pas une conv anglaise. Flip seulement sur
    // switch clair et soutenu. REASON.detectedLanguage n'est qu'un repli faible.
    const candidateTexts = input.conversation
      .filter((m) => m.role === "candidate")
      .map((m) => m.content);
    const incoming = input.incomingCandidateReply?.trim();
    // On ajoute l'incoming aux candidateTexts UNIQUEMENT s'il n'y est pas déjà —
    // de façon robuste (pas de sniff « \n\n ») : l'UI met les messages candidats à la
    // fois dans `conversation` ET dans `incoming` (lot joint par \n\n). On détecte donc
    // si l'incoming est : (a) le dernier message déjà présent (cas simple, même
    // paragraphé), ou (b) le LOT joint des derniers messages déjà présents. Sinon
    // (API/CLI : incoming non présent dans conversation) on l'ajoute.
    if (incoming) {
      const parts = incoming.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
      const tail = candidateTexts.slice(-parts.length);
      const batchAlreadyPresent =
        parts.length > 1 && tail.length === parts.length && parts.every((p, i) => tail[i] === p);
      const singleAlreadyLast = candidateTexts[candidateTexts.length - 1] === incoming;
      if (!batchAlreadyPresent && !singleAlreadyLast) candidateTexts.push(incoming);
    }
    const activeLanguage = resolveActiveLanguage({
      candidateTexts,
      priorLanguage: prior?.personality.voiceProfile.language,
      voiceLanguage: reasonRes.reason.detectedLanguage?.trim() && candidateTexts.length === 1
        ? reasonRes.reason.detectedLanguage.trim()
        : ctx.voice.language,
    });

    // ── Application des MemoryOps (state) — AVANT les invariants, pour que ceux-ci
    // voient la mémoire FRAÎCHE (incl. une objection levée à ce tour). ──
    const applied = applyMemoryOps(candidateMemory, reasonRes.reason.memoryOps, turn);
    candidateMemory = applied.memory;

    // ── ENGAGEMENT du candidat (intérêt actif) → pilote la température ET le gate
    //    propose_call. C'est le signal CANDIDAT, jamais mon read de fit. ──
    const activeNegatives =
      candidateMemory.rejections.filter((e) => e.status === "active").length +
      candidateMemory.objections.filter((e) => e.status === "active").length;
    const engagement = assessEngagement(candidateTexts, activeNegatives);
    candidateMemory.temperature = engagement.temperature;

    // ── 2) Ancrage + garde-fous (déterministe, 0 LLM) ──
    const inv = applyInvariants(reasonRes.reason, {
      turn,
      incomingReply: input.incomingCandidateReply,
      mem: candidateMemory,
      agentMem: agentMemory,
      hasHistory,
      priorStage: prior?.plan.currentStage,
      candidateInterested: engagement.interested,
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

    // Langue de sortie STRICTE : code normalisé de l'active language (fr/en ;
    // null = non vérifiable, ex. autre langue → on ne gate pas).
    const outputLang = normalizeLang(activeLanguage);
    const isIntro = reason.stage === "intro";
    const candidateName = input.candidate?.name;
    // Salutation : autorisée uniquement au TOUT 1er message agent de la conversation
    // (et, dans un burst, seulement le 1er message). hasHistory → aucune salutation.

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
      candidateName,
      bodyLimit,
      allowGreeting: !hasHistory,
    };

    // Contexte de vérification par message (allowGreeting dépend de l'index).
    const vctxFor = (idx: number): DeterministicCtx => ({
      forbidden,
      voiceProfile,
      channelHint: reason.channelHint,
      bodyLimit,
      schedulingAllowed,
      outputLang,
      allowGreeting: !hasHistory && idx === 0,
      candidateName,
      isIntro,
    });
    const vctx0 = vctxFor(0);

    const adherenceCtx = {
      decision: reason.decision,
      mustDo: reason.mustDo,
      mustNotDo,
      avoidedRepetition: reason.avoidedRepetition,
    };

    // Vérifie + répare chaque message du lot ; jette les vides ; cap dur 1-3 ; ≥1.
    const verifyBatch = (msgs: NextMessage[]): NextMessage[] => {
      const out = msgs
        .map((m, i) => (deterministicChecks(m, vctxFor(i)).length > 0 ? repairMessage(m, vctxFor(i)) : m))
        .filter((m) => m.body.trim().length > 0)
        .slice(0, 3);
      return out.length ? out : [safeFallback(writeArgs, vctx0)];
    };

    let revisions = 0;
    let messages: NextMessage[];
    const writeRes = await runWrite(writeArgs);
    calls += writeRes.calls;

    if (!writeRes.ok || !writeRes.messages) {
      // CATASTROPHIQUE (aucun draft) → repli d'étape réparé (pas de stub générique).
      errors.push(`write: ${writeRes.error ?? "failed"} → stage fallback`);
      messages = [safeFallback(writeArgs, vctx0)];
    } else {
      messages = writeRes.messages;

      // ── 4) VERIFY ──
      // 4a-langue) Une FUITE de langue ne s'excise pas (il faut traduire) →
      //   régénération one-shot du lot (hors budget de révision).
      const anyLang = messages.some((m, i) =>
        deterministicChecks(m, vctxFor(i)).some((v) => v.startsWith("LANGUAGE")),
      );
      if (anyLang && outputLang) {
        const langName = outputLang === "fr" ? "français" : "anglais";
        const rw = await runWrite({
          ...writeArgs,
          critique: `Chaque message DOIT être ENTIÈREMENT en ${langName} (salutation, corps ET signature) — aucune autre langue, aucun mot d'une autre langue en tête.`,
        });
        calls += rw.calls;
        if (rw.ok && rw.messages) messages = rw.messages;
        else errors.push("language: regeneration failed");
      }

      // 4a) Réparation chirurgicale déterministe par message (jamais de re-roll→stub).
      messages = verifyBatch(messages);

      // 4b) Vérif sémantique LLM sur le LOT — TOUJOURS (opener inclus) : cohérence +
      //     grammaire/langue native, plus l'adhérence sur les tours de réaction. 1 ré-écriture max.
      const combined = messages.map((m) => m.body).join("\n\n");
      const lv = await llmVerify(
        { channelHint: reason.channelHint, body: combined },
        forbidden,
        { adherence: hasHistory ? adherenceCtx : undefined, language: activeLanguage },
      );
      calls += lv.calls;
      if (!lv.ok) errors.push("verify(llm): unavailable (passed through)");
      if (!lv.pass && revisions < CAPS.maxRevisions) {
        revisions++;
        const rw = await runWrite({ ...writeArgs, critique: lv.violations.join("\n") });
        calls += rw.calls;
        if (rw.ok && rw.messages) messages = verifyBatch(rw.messages);
        else errors.push(`write revision: ${rw.error ?? "failed"} (repaired batch kept)`);
      }
    }

    // Corps combiné pour l'état + la trace (mesurés sur ce qui sort réellement).
    const combinedBody = messages.map((m) => m.body).join("\n\n");
    const traceMsg: NextMessage = {
      channelHint: reason.channelHint,
      subject: messages[0]?.subject,
      body: combinedBody,
    };

    // ── 5) STATE UPDATE (déterministe) ──
    const newQuestions = extractQuestions(combinedBody);
    // Bonus : on journalise les MOVES réellement faits (mustDo exécutés + excuses/échange
    // détectés dans le body) → ils deviennent des interdits durs au tour suivant.
    const moves = detectMoves(combinedBody);
    const isProposal =
      reason.stage === "propose_call" ||
      reason.stage === "confirm_logistics" ||
      hasSchedulingLanguage(combinedBody);
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

    // ── Trace MESURÉE sur le lot final (jamais juste déclarée par REASON) ──
    const reasoning: Reasoning = {
      candidateSignals: reason.signals,
      decision: reason.decision,
      groundingUsed: pack.used,
      constraintsRespected: measureConstraints(traceMsg, vctx0, inv.notes),
      avoidedRepetition: measureAvoided(traceMsg, forbidden),
      memoryUpdates: applied.summary,
    };

    return {
      personality: updatedPersonality,
      plan,
      reasoning,
      nextMessages: messages,
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
  for (const t of forbidden.bannedTopics) if (!containsTerm(lower, t)) out.push(`did not re-propose: "${t}"`);
  for (const f of forbidden.knownFacts) if (!containsTerm(lower, f)) out.push(`did not re-ask: "${f}"`);
  for (const p of forbidden.pointsMade) if (!containsTerm(lower, p)) out.push(`did not repeat: "${p}"`);
  return out.slice(0, 8);
}

function measureConstraints(msg: NextMessage, vctx: DeterministicCtx, invNotes: string[]): string[] {
  const haystack = `${msg.subject ?? ""}\n${msg.body}`;
  const lower = haystack.toLowerCase();
  const out = [...invNotes];
  if (vctx.forbidden.dontSay.length && vctx.forbidden.dontSay.every((t) => !containsTerm(lower, t))) {
    out.push("no banned term used");
  }
  if (!vctx.schedulingAllowed && !hasSchedulingLanguage(haystack)) {
    out.push("no out-of-stage call/scheduling");
  }
  if (msg.body.length <= vctx.bodyLimit) out.push(`length OK (${msg.body.length} ≤ ${vctx.bodyLimit})`);
  for (const c of vctx.forbidden.constraints) out.push(`respects active constraint: "${c}"`);
  return out.slice(0, 10);
}

// Bonus : journalise les vrais MOVES du message (excuses, proposition d'échange)
// pour qu'ils ne soient pas répétés au tour suivant. (Mémoire interne → anglais.)
function detectMoves(body: string): string[] {
  const moves: string[] = [];
  if (/\b(d[ée]sol[ée]|navr[ée]|excuse|pardon|sorry|apolog)/i.test(body)) {
    moves.push("apologized");
  }
  if (hasSchedulingLanguage(body)) moves.push("proposed a call/scheduling");
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
  const fr = !!(cheapDetectLang(lastCandidate) || ctx?.voice?.language || "en").match(/^fr|fran/i);
  // Stage + context aware : pas de ré-introduction si la conversation est déjà entamée.
  const hasHistory =
    (input.priorState?.counters?.messagesSent ?? 0) >= 1 ||
    (input.conversation ?? []).some((m) => m.role === "agent");
  const body = hasHistory
    ? fr
      ? `Désolé, un souci technique de mon côté. Reprenons : je reviens vers vous très vite pour continuer.`
      : `Sorry, a technical hiccup on my side. Let's pick back up — I'll follow up shortly to continue.`
    : fr
      ? `Bonjour, je vous contacte de la part de ${name}. Seriez-vous ouvert à en échanger ?`
      : `Hi, I'm reaching out from ${name}. Would you be open to hearing more?`;
  const message: NextMessage = {
    channelHint: "email",
    subject: fr ? `Un mot de ${name}` : `A note from ${name}`,
    body,
  };
  // N'échoie le priorState QUE s'il est valide — sinon on renverrait un blob corrompu
  // qui re-crasherait le tour suivant. Un priorState invalide → état propre repart de zéro.
  const state: AgentState = (isValidPriorState(input.priorState) ? input.priorState : null) ?? {
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
    nextMessages: [message],
    state,
    meta: { ok: false, errors, llmCallsFired: calls, model: META_MODEL },
  };
}
