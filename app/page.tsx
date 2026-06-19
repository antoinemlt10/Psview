import Link from "next/link";
import { ReasoningPanel } from "@/components/ReasoningPanel";
import type { AgentOutput } from "@/lib/types";

// A static, representative snapshot of the reasoning panel — the hero visual.
// It embodies the product: this is what the agent's "thinking" looks like.
const HERO_OUTPUT: AgentOutput = {
  personality: {
    persona: "Camille — a recruiting agent for PsView, warm and direct.",
    traits: ["warm", "direct", "values ownership"],
    voiceProfile: { tone: "warm and direct", formality: "neutral", emojiUse: "sparing", language: "en" },
    rationale: "",
  },
  plan: {
    goal: "Engage the candidate and book a call",
    currentStage: "handle",
    steps: [
      { stage: "open", objective: "Open with a personalised, context-grounded message" },
      { stage: "qualify", objective: "Understand the candidate's situation and motivations" },
      { stage: "handle", objective: "Address objections (timing, compensation, not looking)" },
      { stage: "book", objective: "Convert interest into a concrete call" },
    ],
  },
  reasoning: {
    candidateSignals: ["objection: timing", "asked a question"],
    decision:
      'Timing objection → stage "handle": defuse pressure and offer a flexible slot, no commitment.',
    groundingUsed: [
      "identity.name",
      "culture.values[0]",
      "hiring.roles[].title",
      "voice.tone",
      "voice.dontSay",
    ],
  },
  nextMessage: { channelHint: "email", body: "" },
};

function Wordmark({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className={`font-display text-lg tracking-tight ${onDark ? "text-on-dark" : "text-ink"}`}>
      Ps<span className={onDark ? "text-on-dark-2" : "text-ink-2"}>View</span>
    </span>
  );
}

function StepCard({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
      <span className="mono mb-4 inline-flex h-7 w-7 items-center justify-center rounded-full border border-line-2 text-xs font-semibold text-ink">
        {String(n).padStart(2, "0")}
      </span>
      <h3 className="font-display mb-1.5 text-xl text-ink">{title}</h3>
      <p className="text-sm leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      {/* HERO — near-black */}
      <section className="bg-ink-bg">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Wordmark onDark />
          <Link
            href="/configure"
            className="rounded-lg border border-line-dark px-3.5 py-1.5 text-sm font-medium text-on-dark transition-colors hover:bg-white/5"
          >
            Configure an agent →
          </Link>
        </header>

        <div className="mx-auto grid max-w-6xl gap-12 px-6 pb-20 pt-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:pb-28 lg:pt-16">
          <div className="animate-fade-up">
            <span className="eyebrow inline-block border-b border-line-dark pb-1 text-on-dark-2">
              Autonomous recruiting agents
            </span>
            <h1 className="font-display mt-6 text-balance text-5xl font-normal leading-[1.06] tracking-tight text-on-dark sm:text-6xl">
              Recruiting agents that{" "}
              <em className="font-display italic">reason</em> before they reach out.
            </h1>
            <p className="mt-6 max-w-md text-pretty text-base leading-relaxed text-on-dark-2">
              Give an agent your company's context once. It configures its own
              personality, plans a sequence, and engages candidates — reading their
              replies and deciding what to do next. Not a prompt wrapper.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/configure"
                className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-ink transition-transform hover:-translate-y-0.5"
              >
                Configure an agent
              </Link>
              <Link
                href="/test"
                className="rounded-lg border border-line-dark px-5 py-2.5 text-sm font-medium text-on-dark transition-colors hover:bg-white/5"
              >
                Open the test area
              </Link>
            </div>
          </div>

          {/* Hero visual: a white reasoning card floating on the dark hero */}
          <div className="animate-fade-up lg:pl-6">
            <ReasoningPanel output={HERO_OUTPUT} />
          </div>
        </div>
      </section>

      {/* The flow — light */}
      <section className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <h2 className="font-display text-3xl text-ink sm:text-4xl">
          Three steps, <span className="text-ink-2">one autonomous agent</span>
        </h2>
        <p className="mb-10 mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
          You give context and intent. The agent does the rest — it isn't driven
          step by step.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <StepCard
            n={1}
            title="Capture the context"
            body="Who the company is, its culture, the roles it hires, and the voice it speaks in. Filled once, persisted for the agent."
          />
          <StepCard
            n={2}
            title="The agent configures itself"
            body="From that context it derives a personality, writes itself a plan, and grounds every message in real company facts."
          />
          <StepCard
            n={3}
            title="Test it live"
            body="Watch the messages it would send. Reply as the candidate by hand and see how it reasons, decides, and adapts."
          />
        </div>
      </section>

      {/* Thesis / CTA band — dark */}
      <section className="bg-ink-bg">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <p className="font-display max-w-3xl text-balance text-2xl italic leading-snug text-on-dark sm:text-3xl">
            "The intelligence isn't in generating text. It's in the loop —{" "}
            <span className="not-italic text-on-dark-2">perceive a signal, decide on a
            stage, act with a grounded message</span>{" "}
            — running over an explicit plan."
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/configure"
              className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-ink transition-transform hover:-translate-y-0.5"
            >
              Configure an agent
            </Link>
            <Link
              href="/test"
              className="rounded-lg border border-line-dark px-5 py-2.5 text-sm font-medium text-on-dark transition-colors hover:bg-white/5"
            >
              Open the test area
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8">
          <Wordmark />
          <p className="text-xs text-muted">
            Technical test build. The reasoning engine runs on a deterministic stub —
            swap it for the real agent without touching the app.
          </p>
        </div>
      </footer>
    </main>
  );
}
