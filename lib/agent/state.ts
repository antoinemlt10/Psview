import type { AgentState, Plan } from "./types";

// Seam de persistance. Implémentation in-memory / round-trip aujourd'hui.
// PAS de base de données : l'état pèse quelques Ko et la test area est éphémère.
// Pour passer à Postgres/KV plus tard : implémenter cette interface dans un seul adapter.
export interface StateStore {
  get(conversationId: string): Promise<AgentState | null>;
  put(conversationId: string, state: AgentState): Promise<void>;
}

export class InMemoryStateStore implements StateStore {
  private store = new Map<string, AgentState>();
  async get(conversationId: string): Promise<AgentState | null> {
    return this.store.get(conversationId) ?? null;
  }
  async put(conversationId: string, state: AgentState): Promise<void> {
    this.store.set(conversationId, state);
  }
}

// Singleton process-level (suffisant en serverless court ; remplaçable via l'interface).
export const defaultStateStore: StateStore = new InMemoryStateStore();

// Plan par défaut : étapes = labels souples (PAS un FSM rigide), le planner raisonne dedans.
// Objectifs internes (trace) → ANGLAIS ; seul le message candidat suit la langue de la conv.
export function defaultPlan(intent: string): Plan {
  return {
    goal: intent,
    currentStage: "intro",
    stages: [
      { stage: "intro", objective: "Establish contact and context." },
      { stage: "value_pitch", objective: "Show the role's value, anchored on the candidate." },
      { stage: "handle_objection", objective: "Address reluctance and objections without re-pitching." },
      { stage: "propose_call", objective: "Propose a call once interest is sufficient." },
      { stage: "confirm_logistics", objective: "Settle the logistics of the call." },
      { stage: "reengage", objective: "Re-engage tactfully if the candidate cools off." },
    ],
  };
}
