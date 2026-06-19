import type { CompanyContext, Message } from "./types";

// Client-side persistence. This is a real deployed app (not a sandbox), so
// localStorage is a legitimate store for the company context + conversation.
// The agent endpoint stays stateless; all state lives here on the client.

const CTX_KEY = "psview.companyContext.v1";
const CONV_KEY = "psview.conversation.v1";
const INTENT_KEY = "psview.intent.v1";
const STATE_KEY = "psview.agentState.v1";

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

export const loadContext = () => read<CompanyContext>(CTX_KEY);
export const saveContext = (ctx: CompanyContext) => write(CTX_KEY, ctx);

export const loadConversation = () => read<Message[]>(CONV_KEY) ?? [];
export const saveConversation = (msgs: Message[]) => write(CONV_KEY, msgs);

export const loadIntent = () => read<string>(INTENT_KEY);
export const saveIntent = (intent: string) => write(INTENT_KEY, intent);

// Rich engine state (memory/plan/counters) — round-tripped as priorState so the
// feedback loop persists across turns. Opaque blob from the UI's point of view.
export const loadAgentState = () => read<Record<string, unknown>>(STATE_KEY);
export const saveAgentState = (state: Record<string, unknown>) => write(STATE_KEY, state);

export function clearConversation(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(CONV_KEY);
  window.localStorage.removeItem(STATE_KEY);
}
