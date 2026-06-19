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
export function defaultPlan(intent: string): Plan {
  return {
    goal: intent,
    currentStage: "intro",
    stages: [
      { stage: "intro", objective: "Établir le contact et le contexte." },
      { stage: "value_pitch", objective: "Montrer la valeur du rôle, ancrée sur le candidat." },
      { stage: "handle_objection", objective: "Adresser réticences et objections sans re-pitcher." },
      { stage: "propose_call", objective: "Proposer un échange quand l'intérêt est suffisant." },
      { stage: "confirm_logistics", objective: "Caler la logistique de l'échange." },
      { stage: "reengage", objective: "Relancer avec tact si le candidat se refroidit." },
    ],
  };
}
