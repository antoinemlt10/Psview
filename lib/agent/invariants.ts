import type { AgentMemory, CandidateMemory, ChannelHint, Stage } from "./types";
import type { ReasonOutput } from "./reason";
import { enforcedEntries } from "./memory";

const CALL_STAGES: Stage[] = ["propose_call", "confirm_logistics"];

function candidateAskedForCall(reply: string | undefined): boolean {
  if (!reply) return false;
  const t = reply.toLowerCase();
  return [
    "appel",
    "appeler",
    "rdv",
    "rendez-vous",
    "planifier",
    "dispo",
    "disponible",
    "call",
    "schedule",
    "meeting",
    "let's talk",
    "échanger",
    "echanger",
  ].some((k) => t.includes(k));
}

export interface InvariantContext {
  turn: number; // 1-based : nombre de messages agent après ce tour
  incomingReply?: string;
  mem: CandidateMemory;
  agentMem: AgentMemory;
  hasHistory: boolean; // ≥1 message agent déjà envoyé (conversation ou priorState)
  priorStage?: Stage; // dernier stage connu (priorState.plan.currentStage)
}

export interface InvariantResult {
  reason: ReasonOutput;
  notes: string[]; // ajouts lisibles à constraintsRespected
}

// Garde-fous déterministes (0 LLM). Le planner raisonne librement DANS ces bornes.
export function applyInvariants(reason: ReasonOutput, ctx: InvariantContext): InvariantResult {
  const notes: string[] = [];
  let stage = reason.stage;
  let nextObjective = reason.nextObjective;

  // 0) CONTINUITÉ : jamais de ré-introduction s'il y a un historique. Si REASON
  //    renvoie "intro" alors qu'on a déjà parlé, on clamp sur le dernier stage connu.
  if (stage === "intro" && ctx.hasHistory) {
    stage = ctx.priorStage && ctx.priorStage !== "intro" ? ctx.priorStage : "reengage";
    nextObjective =
      "Poursuivre la conversation en cours (pas de ré-introduction — historique présent).";
    notes.push(`invariant: pas de ré-intro avec historique → stage clampé sur « ${stage} ».`);
  }

  // 1) Pas de proposition d'appel avant le tour 2, sauf demande explicite du candidat.
  if (CALL_STAGES.includes(stage) && ctx.turn < 2 && !candidateAskedForCall(ctx.incomingReply)) {
    stage = "value_pitch";
    nextObjective = "Établir la pertinence du rôle avant de proposer un échange (trop tôt pour un appel).";
    notes.push("invariant: pas d'appel proposé avant le tour 2 (aucune demande explicite).");
  }

  // 2) Pas de re-pitch par-dessus une objection active : on traite l'objection d'abord.
  const hasActiveObjection =
    enforcedEntries(ctx.mem, "objections").some((e) => e.status === "active") ||
    enforcedEntries(ctx.mem, "rejections").some((e) => e.status === "active");
  if (stage === "value_pitch" && hasActiveObjection) {
    stage = "handle_objection";
    nextObjective = "Adresser l'objection/réticence active avant tout nouveau pitch.";
    notes.push("invariant: objection active → bascule sur handle_objection (pas de re-pitch).");
  }

  // 3) Canal cohérent : valeur sûre par défaut.
  const channelHint: ChannelHint = (["email", "linkedin", "sms"] as ChannelHint[]).includes(
    reason.channelHint,
  )
    ? reason.channelHint
    : "email";

  return { reason: { ...reason, stage, nextObjective, channelHint }, notes };
}
