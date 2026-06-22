"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ReasoningPanel } from "@/components/ReasoningPanel";
import {
  clearConversation,
  loadAgentState,
  loadContext,
  loadConversation,
  loadIntent,
  saveAgentState,
  saveConversation,
  saveIntent,
} from "@/lib/storage";
import type { AgentInput, AgentOutput, CompanyContext, Message } from "@/lib/types";

const DEFAULT_INTENT =
  "engage this candidate for the open role and book a call";

// Délai d'inactivité de frappe (ms) avant que l'agent réponde automatiquement.
const AUTO_REPLY_MS = 3000;

function PersonaCard({ p }: { p: AgentOutput["personality"] }) {
  const name = p.persona.split(/[—-]/)[0]?.trim() || "Agent";
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-display flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink text-lg text-on-dark">
            {initial}
          </span>
          <div>
            <p className="eyebrow">Persona</p>
            <h2 className="font-display text-2xl leading-tight text-ink">{name}</h2>
          </div>
        </div>
        <span className="mono rounded-lg border border-line-2 px-2 py-1 text-[11px] font-medium text-ink-2">
          {p.voiceProfile.language.toUpperCase()} · {p.voiceProfile.formality}
        </span>
      </div>
      <p className="voice mt-3 text-base leading-relaxed text-ink-2">{p.persona}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {p.traits.map((t) => (
          <span
            key={t}
            className="rounded-lg border border-line bg-paper-2 px-2 py-0.5 text-xs text-ink-2"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function Bubble({ m }: { m: Message }) {
  const isAgent = m.role === "agent";
  return (
    <div className={`flex ${isAgent ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isAgent
            ? "rounded-tl-sm border border-line bg-surface shadow-card"
            : "rounded-tr-sm bg-ink text-on-dark"
        }`}
      >
        <div
          className={`mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide ${
            isAgent ? "text-muted" : "text-on-dark-2"
          }`}
        >
          <span className="mono">{isAgent ? "agent" : "candidate"}</span>
          {m.channel && <span className="mono">· {m.channel}</span>}
        </div>
        {m.subject && (
          <p
            className={`font-display mb-1 text-sm font-medium ${
              isAgent ? "text-ink" : "text-on-dark"
            }`}
          >
            {m.subject}
          </p>
        )}
        <p
          className={`whitespace-pre-wrap text-[15px] leading-relaxed ${
            isAgent ? "voice text-ink" : "voice text-on-dark"
          }`}
        >
          {m.content}
        </p>
      </div>
    </div>
  );
}

export default function TestPage() {
  const [ctx, setCtx] = useState<CompanyContext | null>(null);
  const [ready, setReady] = useState(false);
  const [intent, setIntent] = useState(DEFAULT_INTENT);
  const [messages, setMessages] = useState<Message[]>([]);
  const [output, setOutput] = useState<AgentOutput | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string[]>([]); // messages candidat en file
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const openedRef = useRef(false);

  // Core call to the (stateless) agent endpoint.
  const runAgent = useCallback(
    async (
      context: CompanyContext,
      conversation: Message[],
      currentIntent: string,
      incomingCandidateReply?: string,
    ) => {
      setLoading(true);
      setError("");
      try {
        const input: AgentInput = {
          companyContext: context,
          intent: currentIntent,
          conversation,
          incomingCandidateReply,
          // round-trip the engine's rich state so memory persists across turns
          priorState: loadAgentState() ?? undefined,
        };
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `Agent returned ${res.status}`);
        }
        const out = (await res.json()) as AgentOutput;
        // L'agent peut renvoyer plusieurs messages (burst) → une bulle chacun.
        const agentMsgs: Message[] = out.nextMessages.map((m) => ({
          role: "agent",
          content: m.body,
          channel: m.channelHint,
          subject: m.subject,
          ts: Date.now(),
        }));
        const next = [...conversation, ...agentMsgs];
        setMessages(next);
        saveConversation(next);
        if (out.state) saveAgentState(out.state);
        setOutput(out);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Hydrate from localStorage; auto-generate the opening message once.
  useEffect(() => {
    const c = loadContext();
    setCtx(c);
    const savedIntent = loadIntent();
    if (savedIntent) setIntent(savedIntent);
    const conv = loadConversation();
    setMessages(conv);
    setReady(true);

    if (c && conv.length === 0 && !openedRef.current) {
      openedRef.current = true;
      void runAgent(c, [], savedIntent || DEFAULT_INTENT);
    } else if (conv.length > 0) {
      openedRef.current = true;
    }
  }, [runAgent]);

  // Met en file un message candidat SANS déclencher l'agent (multi-messages entrée).
  // Mises à jour FONCTIONNELLES → des Entrées rapides ne perdent aucun message.
  const queueReply = () => {
    const reply = draft.trim();
    if (!reply || !ctx || loading) return;
    const candidateMsg: Message = { role: "candidate", content: reply, ts: Date.now() };
    setMessages((prev) => {
      const next = [...prev, candidateMsg];
      saveConversation(next);
      return next;
    });
    setPending((p) => [...p, reply]);
    setDraft("");
  };

  // Déclenche l'agent : REASON traite le LOT de messages candidat non-répondus.
  const requestAgentReply = () => {
    if (!ctx || loading) return;
    // un éventuel brouillon non encore mis en file est inclus
    const draftText = draft.trim();
    let convo = messages;
    let batch = pending;
    if (draftText) {
      const candidateMsg: Message = { role: "candidate", content: draftText, ts: Date.now() };
      convo = [...messages, candidateMsg];
      batch = [...pending, draftText];
      setMessages(convo);
      saveConversation(convo);
      setDraft("");
    }
    setPending([]);
    const incoming = batch.length ? batch.join("\n\n") : undefined;
    void runAgent(ctx, convo, intent, incoming);
  };

  // L'agent répond TOUT SEUL quand le candidat arrête de taper (debounce).
  // Tant que `draft` ou `pending` changent (= frappe / envoi), le minuteur est
  // réarmé → l'agent n'interrompt jamais une saisie en cours. Quand ça se stabilise
  // pendant AUTO_REPLY_MS avec du contenu à traiter, il répond.
  const replyRef = useRef(requestAgentReply);
  replyRef.current = requestAgentReply;
  useEffect(() => {
    if (!ready || !ctx || loading) return;
    if (pending.length === 0 && !draft.trim()) return; // rien à traiter
    const id = setTimeout(() => replyRef.current(), AUTO_REPLY_MS);
    return () => clearTimeout(id);
  }, [draft, pending, loading, ctx, ready]);

  const resetConversation = () => {
    if (!ctx) return;
    clearConversation();
    setMessages([]);
    setPending([]);
    setOutput(null);
    void runAgent(ctx, [], intent);
  };

  if (!ready) return <main className="min-h-screen" />;

  // No context yet → CTA to configure.
  if (!ctx) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
          <h1 className="font-display text-2xl text-ink">No company context yet</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            The agent needs a context to configure itself. Fill it once and come
            back here.
          </p>
          <Link
            href="/configure"
            className="mt-5 inline-block rounded-lg bg-ink px-5 py-2.5 text-sm font-semibold text-on-dark transition-transform hover:-translate-y-0.5"
          >
            Configure the agent →
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen pb-16">
      {/* Stub banner — monochrome */}
      <div className="border-b border-line bg-paper-2">
        <p className="mx-auto max-w-6xl px-6 py-2 text-center text-xs text-ink-2">
          Live reasoning engine (<span className="mono">lib/agent/runAgent</span>) · real
          Claude calls. Memory persists across turns; the reasoning panel shows the
          feedback loop.
        </p>
      </div>

      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <Link href="/" className="font-display text-lg tracking-tight text-ink">
            Ps<span className="text-ink-2">View</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/configure"
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:border-ink"
            >
              Edit context
            </Link>
            <button
              type="button"
              onClick={resetConversation}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:border-ink hover:text-ink"
            >
              Restart conversation
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-6 pt-6 lg:grid-cols-[1fr_360px]">
        {/* LEFT: persona + thread + composer */}
        <div className="flex flex-col gap-5">
          {output && <PersonaCard p={output.personality} />}

          {/* Intent */}
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
            <label className="mb-1.5 block text-sm font-medium text-ink">Intent</label>
            <p className="mb-2 text-xs text-muted">
              The goal you hand the agent. It plans and reasons toward this.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={intent}
                onChange={(e) => {
                  setIntent(e.target.value);
                  saveIntent(e.target.value);
                }}
                className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-ink"
              />
              <button
                type="button"
                onClick={resetConversation}
                disabled={loading}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-ink disabled:opacity-50"
              >
                Apply & regenerate
              </button>
            </div>
          </div>

          {/* Thread */}
          <div className="flex flex-col gap-3 rounded-2xl border border-line bg-paper-2 p-5">
            {messages.length === 0 && loading && (
              <p className="py-8 text-center text-sm text-muted">
                The agent is composing its opening message…
              </p>
            )}
            {messages.map((m, i) => (
              <Bubble key={i} m={m} />
            ))}
            {messages.length > 0 && loading && (
              <p className="text-center text-xs text-muted">The agent is thinking…</p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-ink">
              {error}
            </p>
          )}

          {/* Composer */}
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
            <label className="mb-2 block text-sm font-medium text-ink">
              Reply as the candidate
            </label>
            {(pending.length > 0 || draft.trim()) && !loading && (
              <p className="mb-2 text-xs text-muted">
                {pending.length > 0 ? `${pending.length} message${pending.length > 1 ? "s" : ""} en file — ` : ""}
                l'agent répond automatiquement dès que tu arrêtes d'écrire (~3 s).
              </p>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter = envoyer un message candidat (bulle) ; Shift+Enter = saut de ligne ;
                // ⌘/Ctrl+Enter = envoyer puis déclencher l'agent.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  requestAgentReply();
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  queueReply();
                }
              }}
              placeholder="Écris un message candidat, Entrée pour l'envoyer. Plusieurs d'affilée = plusieurs bulles."
              className="min-h-[72px] w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-ink"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted">
                Entrée = envoyer un message · Maj+Entrée = saut de ligne · l'agent répond à la pause
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={queueReply}
                  disabled={loading || !draft.trim()}
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send message
                </button>
                <button
                  type="button"
                  onClick={requestAgentReply}
                  disabled={loading || (!draft.trim() && pending.length === 0)}
                  className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-dark transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Ne pas attendre la pause"
                >
                  Reply now →
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: reasoning panel */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          {output ? (
            <ReasoningPanel output={output} />
          ) : (
            <div className="rounded-2xl border border-line bg-surface p-5 text-sm text-muted shadow-card">
              The reasoning panel will appear once the agent acts.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
