import type { AgentOutput } from "@/lib/types";

// ── THE SIGNATURE COMPONENT ──────────────────────────────────────────────────
// Renders the agent's "brain": the signals it detected, the decision it made,
// the explicit plan it's moving through (vertical stepper, current stage lit),
// and the exact context fields it grounded its message in.
// Monochrome: meaning is carried by shape (filled dot vs ring) and weight, not colour.

function signalKind(signal: string): "objection" | "positive" | "neutral" {
  const s = signal.toLowerCase();
  if (s.includes("objection")) return "objection";
  if (s.includes("intérêt") || s.includes("interest")) return "positive";
  return "neutral";
}

function SignalDot({ kind }: { kind: "objection" | "positive" | "neutral" }) {
  if (kind === "objection") {
    // filled disc = friction
    return <span className="inline-block h-2 w-2 rounded-full bg-ink" />;
  }
  if (kind === "positive") {
    // ring = opening / positive
    return <span className="inline-block h-2 w-2 rounded-full border-[1.5px] border-ink" />;
  }
  // half / neutral
  return <span className="inline-block h-2 w-2 rounded-full border border-line-2 bg-paper-2" />;
}

export function ReasoningPanel({ output }: { output: AgentOutput }) {
  const { reasoning, plan } = output;
  const signals = reasoning.candidateSignals ?? [];

  return (
    <aside
      aria-label="Agent reasoning"
      className="flex flex-col gap-6 rounded-2xl border border-line bg-surface p-5 shadow-card"
    >
      <header className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-ink" />
        <h2 className="font-display text-base text-ink">Reasoning</h2>
        <span className="mono ml-auto text-[11px] uppercase tracking-wide text-muted">
          {output.meta ? `${output.meta.llmCallsFired} LLM · ` : ""}stage · {plan.currentStage}
        </span>
      </header>
      {output.meta && !output.meta.ok && (
        <p className="mono rounded-lg border border-line-2 bg-paper-2 px-2.5 py-1.5 text-[11px] text-ink-2">
          fallback — {output.meta.errors[0] ?? "dégradé"}
        </p>
      )}

      {/* SIGNALS */}
      <section>
        <h3 className="eyebrow mb-2">Signals detected</h3>
        {signals.length === 0 ? (
          <p className="text-sm text-ink-2">No candidate reply yet — opening cold.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {signals.map((s, i) => {
              const kind = signalKind(s);
              return (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1.5 rounded-lg border border-line-2 px-2 py-1 text-xs text-ink ${
                    kind === "objection" ? "font-semibold" : "font-medium"
                  }`}
                >
                  <SignalDot kind={kind} />
                  {s}
                </span>
              );
            })}
          </div>
        )}
      </section>

      {/* DECISION */}
      <section>
        <h3 className="eyebrow mb-2">Decision</h3>
        <p className="rounded-lg border border-line border-l-2 border-l-ink bg-paper-2 px-3 py-2.5 text-sm leading-relaxed text-ink">
          {reasoning.decision}
        </p>
      </section>

      {/* PLAN — vertical stepper */}
      <section>
        <h3 className="eyebrow mb-3">Plan · {plan.goal}</h3>
        <ol className="relative flex flex-col gap-0">
          {plan.stages.map((step, i) => {
            const active = step.stage === plan.currentStage;
            const idx = plan.stages.findIndex((s) => s.stage === plan.currentStage);
            const done = i < idx;
            const last = i === plan.stages.length - 1;
            return (
              <li key={step.stage} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                      active
                        ? "bg-ink text-on-dark"
                        : done
                          ? "bg-ink text-on-dark"
                          : "border border-line-2 bg-surface text-muted"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  {!last && (
                    <span
                      className={`w-px flex-1 ${done ? "bg-ink/40" : "bg-line"}`}
                      style={{ minHeight: 18 }}
                    />
                  )}
                </div>
                <div className={`pb-4 ${active ? "" : "opacity-70"}`}>
                  <p
                    className={`text-sm capitalize ${
                      active ? "font-semibold text-ink" : "font-medium text-ink"
                    }`}
                  >
                    {step.stage}
                    {active && (
                      <span className="ml-2 rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-dark">
                        now
                      </span>
                    )}
                  </p>
                  <p className="text-xs leading-relaxed text-ink-2">{step.objective}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {/* GROUNDING */}
      <section>
        <h3 className="eyebrow mb-2">Grounding · context fields used</h3>
        <ul className="flex flex-col">
          {reasoning.groundingUsed.map((g) => (
            <li
              key={g}
              className="mono border-b border-line py-1 text-[12px] leading-relaxed text-ink-2 last:border-0"
            >
              <span className="text-muted">→</span> {g}
            </li>
          ))}
        </ul>
      </section>

      {/* FEEDBACK LOOP — the proof of intelligence (real engine only) */}
      <LoopSection title="Constraints respected" items={reasoning.constraintsRespected} mark="✓" />
      <LoopSection title="Avoided repetition" items={reasoning.avoidedRepetition} mark="∅" />
      <LoopSection title="Memory updates" items={reasoning.memoryUpdates} mark="Δ" />
    </aside>
  );
}

function LoopSection({ title, items, mark }: { title: string; items?: string[]; mark: string }) {
  if (!items || items.length === 0) return null;
  return (
    <section>
      <h3 className="eyebrow mb-2">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <li
            key={i}
            className="flex gap-2 rounded-lg border border-line-2 bg-paper-2 px-2.5 py-1.5 text-xs leading-relaxed text-ink-2"
          >
            <span className="mono shrink-0 text-ink">{mark}</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
