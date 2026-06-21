// ── Le contrat du moteur d'agent PSVIEW ──
// Types partagés avec l'UI finale (formulaire + test area) et la route /api/agent.
// Ne pas casser ce contrat : l'UI le consomme tel quel.

export type Formality = "casual" | "neutral" | "formal";
export type EmojiUse = "none" | "sparing" | "liberal";
export type ChannelHint = "email" | "linkedin" | "sms";

// ── Contrat partagé avec l'UI ──
export interface CompanyContext {
  identity: { name: string; oneLiner: string; industry: string; sizeStage: string; website?: string };
  culture: { values: string[]; cultureNotes: string; workStyle?: string };
  hiring: {
    roles: { title: string; seniority: string; whatTheyllDo: string; mustHaveSkills: string[] }[];
    idealCandidateTraits: string[];
  };
  voice: { tone: string; formality: Formality; language: string; emojiUse: EmojiUse; dontSay?: string[] };
}

export interface Message {
  role: "agent" | "candidate";
  content: string;
  ts?: number;
}

export interface AgentInput {
  companyContext: CompanyContext;
  intent: string;
  candidate?: { name?: string; headline?: string; notes?: string };
  conversation: Message[];
  incomingCandidateReply?: string;
  priorState?: AgentState; // round-trip de l'état entre les tours
}

// ── Personnalité (auto-config) ──
export interface VoiceProfile {
  formality: Formality;
  emojiUse: EmojiUse;
  language: string;
  styleAdjustments: string[];
}
export interface Personality {
  persona: string;
  traits: string[];
  voiceProfile: VoiceProfile;
  rationale: string;
}

// ── Plan (étapes = labels souples, PAS un FSM rigide) ──
export type Stage =
  | "intro"
  | "value_pitch"
  | "handle_objection"
  | "propose_call"
  | "confirm_logistics"
  | "reengage";
export interface Plan {
  goal: string;
  stages: { stage: Stage; objective: string }[];
  currentStage: Stage;
}

// ── Mémoire candidat (la boucle de feedback) ──
export type MemoryStatus = "active" | "resolved" | "retracted" | "softened" | "superseded";
export interface MemoryEntry {
  id: string;
  content: string;
  turn: number;
  status: MemoryStatus;
  strength?: number; // 0..1 : réversion molle vs dure
  condition?: string; // pour "softened"/conditionnel
  resolvedTurn?: number;
  cause?: "agent_persuaded" | "candidate_reversed";
}
export interface CandidateMemory {
  rejections: MemoryEntry[];
  constraints: MemoryEntry[];
  objections: MemoryEntry[];
  facts: MemoryEntry[];
  dismissedTopics: MemoryEntry[];
  styleFeedback: MemoryEntry[];
  temperature: "cold" | "lukewarm" | "warm" | "hot";
}
export interface AgentMemory {
  pointsMade: string[];
  questionsAsked: string[];
  proposalsMade: string[];
}

export interface AgentState {
  personaKey: string; // hash(companyContext) → persona stable
  personality: Personality; // caché
  plan: Plan;
  candidateMemory: CandidateMemory;
  agentMemory: AgentMemory;
  counters: {
    messagesSent: number;
    revisions: number;
    objectionsRaised: number;
    objectionsResolved: number;
  };
}

// ── Trace + sortie ──
export interface Reasoning {
  candidateSignals?: string[];
  decision: string;
  groundingUsed: string[];
  constraintsRespected: string[]; // surface la boucle de feedback
  avoidedRepetition: string[]; // surface l'anti-répétition
  memoryUpdates?: string[]; // résumé lisible de ce qui a changé
}
export interface NextMessage {
  channelHint: ChannelHint;
  subject?: string;
  body: string;
}
export interface AgentMeta {
  ok: boolean;
  errors: string[];
  llmCallsFired: number;
  model: string;
}

export interface AgentOutput {
  personality: Personality;
  plan: Plan;
  reasoning: Reasoning;
  nextMessages: NextMessage[]; // 1 à 3 messages (burst), rendus en bulles séparées
  state: AgentState;
  meta: AgentMeta;
}

// ── Bucket de mémoire candidat ciblable par une MemoryOp ──
export type MemoryBucket = keyof Omit<CandidateMemory, "temperature">;

// ── Interne : ops de mutation de mémoire émises par REASON ──
export type MemoryOp =
  | { op: "add"; bucket: MemoryBucket; content: string; strength?: number; condition?: string }
  | { op: "retract"; targetId: string }
  | { op: "soften"; targetId: string; condition?: string; strength?: number }
  | { op: "resolve"; targetId: string }
  | { op: "supersede"; targetId: string; content: string };

// L'interface publique du moteur est exportée par ./runAgent :
//   export function runAgent(input: AgentInput): Promise<AgentOutput>
