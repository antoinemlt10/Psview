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
import { META_MODEL, CAPS } from "./config";
import { hashContext, getPersonality, deriveVoiceProfile, fallbackPersonality } from "./persona";
import {
  emptyCandidateMemory,
  emptyAgentMemory,
  applyMemoryOps,
  updateTemperature,
  deriveStyleAdjustments,
} from "./memory";
import { runReason, cheapDetectLang } from "./reason";
import { applyInvariants } from "./invariants";
import { buildGroundingPack, buildForbiddenList } from "./grounding";
import { runWrite, fallbackMessage, fallbackLang, type WriteArgs } from "./write";
import { deterministicChecks, llmVerify, needsLlmVerify, type DeterministicCtx } from "./verify";
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
    const writeArgs: WriteArgs = {
      nextObjective: reason.nextObjective,
      stage: reason.stage,
      channelHint: reason.channelHint,
      pack,
      voiceProfile,
      forbidden,
      persona: personality.persona,
    };

    // Contexte de vérification, partagé par VERIFY et par le fallback (qui est
    // lui aussi vérifié+assaini : jamais de message non vérifié qui sort).
    const vctx = { forbidden, voiceProfile, channelHint: reason.channelHint };

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
      while (true) {
        let violations = deterministicChecks(message, vctx);
        if (violations.length === 0 && needsLlmVerify(message, forbidden)) {
          const lv = await llmVerify(message, forbidden);
          calls += lv.calls;
          if (!lv.ok) errors.push("verify(llm): indisponible (laissé passer)");
          if (!lv.pass) violations = lv.violations;
        }
        if (violations.length === 0) break; // message vérifié → on l'expédie

        if (revisions >= CAPS.maxRevisions) {
          errors.push(`verify: échec après révision (${violations.join(" | ")}) → fallback`);
          message = safeFallback(writeArgs, vctx);
          break;
        }
        revisions++;
        const rw = await runWrite({ ...writeArgs, critique: violations.join("\n") });
        calls += rw.calls;
        if (rw.ok && rw.message) {
          message = rw.message;
        } else {
          errors.push(`révision write: ${rw.error ?? "échec"} → fallback`);
          message = safeFallback(writeArgs, vctx);
          break;
        }
      }
    }

    // ── 5) STATE UPDATE (déterministe) ──
    const newQuestions = extractQuestions(message.body);
    const isProposal = reason.stage === "propose_call" || reason.stage === "confirm_logistics";
    agentMemory = {
      pointsMade: pushUnique(agentMemory.pointsMade, [reason.nextObjective]),
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

    // ── Trace (rend la boucle de feedback VISIBLE) ──
    const avoidedRepetition =
      reason.avoidedRepetition.length > 0
        ? reason.avoidedRepetition
        : deriveAvoided(forbidden);

    const reasoning: Reasoning = {
      candidateSignals: reason.signals,
      decision: reason.decision,
      groundingUsed: pack.used,
      constraintsRespected: [...reason.constraintsRespected, ...inv.notes],
      avoidedRepetition,
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

function deriveAvoided(forbidden: ReturnType<typeof buildForbiddenList>): string[] {
  const out: string[] = [];
  for (const t of forbidden.bannedTopics) out.push(`n'a pas reproposé : « ${t} »`);
  for (const f of forbidden.knownFacts) out.push(`n'a pas re-demandé : « ${f} »`);
  for (const p of forbidden.pointsMade) out.push(`n'a pas répété : « ${p} »`);
  return out;
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
