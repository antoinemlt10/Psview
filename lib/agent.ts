// ─────────────────────────────────────────────────────────────────────────────
// REAL ENGINE ADAPTER
// Replaces lib/stub-agent.ts. Wires the autonomous reasoning engine (lib/agent/*)
// behind the app's AgentInput → AgentOutput contract.
//
// The engine has a slightly richer internal contract than the UI:
//   • plan.stages  → mapped to UI plan.steps
//   • voiceProfile gains `tone` from the company context (engine derives the rest)
//   • reasoning carries the feedback loop (constraintsRespected / avoidedRepetition /
//     memoryUpdates) — surfaced in the ReasoningPanel
//   • the engine's rich AgentState round-trips through AgentOutput.state ↔
//     AgentInput.priorState so memory persists across turns (the client stores it).
// ─────────────────────────────────────────────────────────────────────────────

import { runAgent as runEngine } from "./agent/runAgent";
import type {
  AgentInput as EngineInput,
  AgentState as EngineState,
  CompanyContext as EngineContext,
} from "./agent/types";
import type { AgentInput, AgentOutput, Language } from "./types";

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const engineInput: EngineInput = {
    companyContext: input.companyContext as unknown as EngineContext,
    intent: input.intent,
    candidate: input.candidate,
    conversation: input.conversation,
    incomingCandidateReply: input.incomingCandidateReply,
    priorState: input.priorState as EngineState | undefined,
  };

  const out = await runEngine(engineInput);

  return {
    personality: {
      persona: out.personality.persona,
      traits: out.personality.traits,
      voiceProfile: {
        tone: input.companyContext.voice.tone,
        formality: out.personality.voiceProfile.formality,
        emojiUse: out.personality.voiceProfile.emojiUse,
        language: out.personality.voiceProfile.language as Language,
      },
      rationale: out.personality.rationale,
    },
    plan: {
      goal: out.plan.goal,
      steps: out.plan.stages,
      currentStage: out.plan.currentStage,
    },
    reasoning: {
      candidateSignals: out.reasoning.candidateSignals,
      decision: out.reasoning.decision,
      groundingUsed: out.reasoning.groundingUsed,
      constraintsRespected: out.reasoning.constraintsRespected,
      avoidedRepetition: out.reasoning.avoidedRepetition,
      memoryUpdates: out.reasoning.memoryUpdates,
    },
    nextMessages: out.nextMessages.map((m) => ({
      channelHint: m.channelHint,
      subject: m.subject,
      body: m.body,
    })),
    // Full engine state, opaque to the UI, echoed back next turn as priorState.
    state: out.state as unknown as Record<string, unknown>,
    meta: out.meta,
  };
}
