// ─────────────────────────────────────────────────────────────────────────────
// SHARED CONTRACT — single source of truth is lib/agent/types.ts (the engine).
// This file is a thin façade so UI code can keep importing from "@/lib/types".
// There is now ONE definition of CompanyContext / AgentInput / AgentOutput / etc.
// (no more duplicate types, no `as unknown as` adapter).
// ─────────────────────────────────────────────────────────────────────────────

export type {
  Formality,
  EmojiUse,
  ChannelHint,
  Channel,
  Language,
  Role,
  CompanyContext,
  Message,
  AgentInput,
  AgentOutput,
  AgentState,
  NextMessage,
  Personality,
  VoiceProfile,
  Plan,
  Stage,
  Reasoning,
  AgentMeta,
  CandidateMemory,
  AgentMemory,
  MemoryEntry,
} from "./agent/types";
