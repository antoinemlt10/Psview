// ─────────────────────────────────────────────────────────────────────────────
// SHARED CONTRACT
// This file is the single source of truth between two workstreams:
//   • the /configure form PRODUCES a CompanyContext
//   • the agent (POST /api/agent) CONSUMES an AgentInput and RETURNS an AgentOutput
// Keep it in sync with the reasoning-engine workstream. Nothing else should drift.
// ─────────────────────────────────────────────────────────────────────────────

export type Formality = "casual" | "neutral" | "formal";
export type EmojiUse = "none" | "sparing" | "liberal";
export type Language = "fr" | "en";
export type Channel = "email" | "linkedin" | "sms";

export interface Role {
  title: string;
  seniority: string;
  whatTheyllDo: string;
  mustHaveSkills: string[];
}

export interface CompanyContext {
  identity: {
    name: string;
    oneLiner: string;
    industry: string;
    sizeStage: string;
    website?: string;
  };
  culture: {
    values: string[];
    cultureNotes: string;
    workStyle?: string;
  };
  hiring: {
    roles: Role[];
    idealCandidateTraits: string[];
  };
  voice: {
    tone: string;
    formality: Formality;
    language: Language;
    emojiUse: EmojiUse;
    dontSay?: string[];
  };
}

export interface Message {
  role: "agent" | "candidate";
  content: string;
  channel?: Channel;
  subject?: string;
  ts?: number;
}

export interface AgentInput {
  companyContext: CompanyContext;
  intent: string; // e.g. "engage this candidate for the Founding Engineer role and book a call"
  candidate?: { name?: string; headline?: string; notes?: string };
  conversation: Message[];
  incomingCandidateReply?: string; // hand-simulated candidate reply to react to
  // Round-trip of the engine's rich state between turns (memory, plan, counters).
  // Opaque to the UI: it stores it and echoes it back so memory persists across turns.
  priorState?: Record<string, unknown>;
}

export interface AgentOutput {
  personality: {
    persona: string;
    traits: string[];
    voiceProfile: {
      tone: string;
      formality: Formality;
      emojiUse: EmojiUse;
      language: Language;
    };
    rationale: string;
  };
  plan: {
    goal: string;
    steps: { stage: string; objective: string }[];
    currentStage: string;
  };
  reasoning: {
    candidateSignals?: string[];
    decision: string;
    groundingUsed: string[];
    // The feedback loop, made visible (populated by the real engine).
    constraintsRespected?: string[];
    avoidedRepetition?: string[];
    memoryUpdates?: string[];
  };
  nextMessage: {
    channelHint: Channel;
    subject?: string;
    body: string;
  };
  state?: Record<string, unknown>;
}
