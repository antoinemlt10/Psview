import type { AgentMemory, CandidateMemory, ChannelHint, Stage } from "./types";
import type { ReasonOutput } from "./reason";
import { enforcedEntries } from "./memory";

const CALL_STAGES: Stage[] = ["propose_call", "confirm_logistics"];

export function candidateAskedForCall(reply: string | undefined): boolean {
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

// ── INTÉRÊT du candidat (signal candidat), distinct du FIT (mon évaluation) ──
// Une réponse factuelle à une question de screening (« C-level/VP ») n'est PAS de
// l'intérêt. L'intérêt = le candidat pose une vraie question sur l'opportunité, OU
// exprime une ouverture claire, OU demande un appel.
const OPPORTUNITY_TOPIC =
  /\b(role|position|poste|job|team|[ée]quipe|comp|salar|salaire|equity|stock|pay|r[ée]mun|growth|croissance|remote|t[ée]l[ée]travail|stack|tech|product|produit|mission|culture|scope|responsib|fundrais|runway|invest|onboard|start|d[ée]but|process|next step|prochaine[s]? [ée]tape)/i;
const OPENNESS =
  /\b(interested|keen|excited|sounds good|tell me more|i'?m in|love to|curious|open to|happy to|why not|int[ée]ress|partant|dis m'en plus|avec plaisir|volontiers|ouvert|pourquoi pas|ç?a m'int[ée]resse)\b/i;

export function isOpportunityQuestion(text: string): boolean {
  return text.includes("?") && OPPORTUNITY_TOPIC.test(text);
}
export function showsOpenness(text: string): boolean {
  return OPENNESS.test(text);
}

export interface Engagement {
  interestSignals: number;
  askedCall: boolean;
  interested: boolean; // ≥1 signal d'intérêt OU demande d'appel
  temperature: CandidateMemory["temperature"];
}

// Température PILOTÉE PAR L'ENGAGEMENT du candidat (ses questions / son lean-in),
// PAS par mon read de fit. Les réponses de screening n'augmentent pas la température.
export function assessEngagement(
  candidateTexts: string[],
  activeNegatives: number,
): Engagement {
  let interestSignals = 0;
  let askedCall = false;
  for (const t of candidateTexts) {
    if (isOpportunityQuestion(t) || showsOpenness(t)) interestSignals++;
    if (candidateAskedForCall(t)) askedCall = true;
  }
  let temperature: CandidateMemory["temperature"];
  if (askedCall || interestSignals >= 2) temperature = "hot";
  else if (interestSignals >= 1) temperature = "warm";
  else if (activeNegatives > 0) temperature = "cold";
  else temperature = "lukewarm";
  return { interestSignals, askedCall, interested: askedCall || interestSignals >= 1, temperature };
}

export interface InvariantContext {
  turn: number; // 1-based : nombre de messages agent après ce tour
  incomingReply?: string;
  mem: CandidateMemory;
  agentMem: AgentMemory;
  hasHistory: boolean; // ≥1 message agent déjà envoyé (conversation ou priorState)
  priorStage?: Stage; // dernier stage connu (priorState.plan.currentStage)
  candidateInterested: boolean; // intérêt actif accumulé (questions/ouverture/demande d'appel)
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

  // 2) Pas de re-pitch par-dessus une objection active : on traite l'objection d'abord.
  const hasActiveObjection =
    enforcedEntries(ctx.mem, "objections").some((e) => e.status === "active") ||
    enforcedEntries(ctx.mem, "rejections").some((e) => e.status === "active");

  // 1) GATE INTÉRÊT : propose_call/confirm_logistics seulement si le candidat a montré
  //    un intérêt ACTIF (≥1 question substantielle / ouverture claire) OU demandé un appel.
  //    Répondre à mes questions de screening n'est PAS de l'intérêt. Sinon → on reste
  //    en value_pitch (ou handle_objection si objection active). Couvre aussi le tour 1.
  if (
    CALL_STAGES.includes(stage) &&
    !ctx.candidateInterested &&
    !candidateAskedForCall(ctx.incomingReply)
  ) {
    stage = hasActiveObjection ? "handle_objection" : "value_pitch";
    nextObjective =
      "Susciter l'intérêt avant tout appel : le candidat n'a pas encore montré d'intérêt actif (pas de question sur l'opportunité ni d'ouverture). Apporter de la valeur, sans proposer d'échange.";
    notes.push(
      "invariant: pas d'intérêt actif du candidat → pas de proposition d'appel (clamp sur " +
        stage +
        ").",
    );
  }
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
