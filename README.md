# PsView — Autonomous Recruiting Agent

An autonomous agent that engages candidates on a company's behalf — it configures its own personality from the company's context, reasons about each reply, and runs the conversation on its own. Not a prompt wrapper.

**Live demo:** https://psview-git-main-antoinemlt10s-projects.vercel.app/
**Repo:** https://github.com/antoinemlt10/Psview

---

## What it does

You give the agent a **company context** (who it is, culture, the roles it hires, its voice) and an **intent** (e.g. *"engage this candidate for the Chief of Staff role and book a call"*). From that alone it gives itself a personality, decides a strategy, and runs the conversation — adapting to each candidate reply, with no step-by-step driving. Everything is previewed in a test area: no real sends. You simulate candidate replies by hand and watch the agent reason and react.

## What makes it intelligent (not just an LLM call)

The intelligence is the loop, not the text generation. The agent runs a closed **reason → decide → act** cycle over persistent state: a **planner** decides the next move under hard constraints (never re-propose what the candidate rejected, never re-ask what's already known, never push a call before real interest is shown), a separate **writer** executes that decision in a fixed persona, and **deterministic gates** enforce the decision on the actual output before anything is sent. The conversation state — an explicit plan plus a two-sided memory with a constraint lifecycle — carries across every turn. A single LLM call has none of this: no plan, no memory of strategy, no separation between deciding and writing, no verification, and no stable personality.

## Architecture

Per turn the engine runs a small pipeline. **Not every step is an LLM call** — the structure (a stage vocabulary plus invariants in code, with the LLM reasoning *inside* it) is what makes this an agent rather than a wrapper.

1. **REASON** *(1 LLM call)* — reads the candidate's reply, extracts signals, updates the candidate memory (including *reversals* — when the candidate takes back or softens an earlier constraint), and emits the next move as a structured object: stage, objective, explicit do/don't directives, and which context fields to ground in — constrained by active memory.
2. **Grounding + gates** *(deterministic)* — assembles the exact context fields the planner chose, enforces invariants (no call before interest; no re-pitch; channel length), and hands the writer an explicit list of forbidden moves: rejected topics, points already made, questions already asked, banned terms.
3. **WRITE** *(1 LLM call)* — writes the message from the turn objective + grounding + persona + the forbidden list. The writer is **goal-blind**: it never sees the global "book a call" intent, so it can't drift toward scheduling on its own. It executes the decision; it doesn't strategize.
4. **VERIFY** *(deterministic first, LLM only when ambiguous)* — hard checks in code (banned terms, language, length, markdown, placeholders, scheduling-out-of-stage, repetition against memory). On a fixable violation the message is **repaired surgically** (the offending sentence is stripped, the body truncated to a clean sentence) rather than regenerated-then-stubbed — which guarantees convergence. A generic fallback fires only on a catastrophic failure (planner crash / empty output), and stays context- and language-aware even then.
5. **State update** *(deterministic)* — applies the memory operations, updates engagement temperature, returns the full output + new state.

**Typical cost: ~2 LLM calls per reaction turn** (3 on the cold open, including the one-time persona synthesis). The memory and feedback loop add **zero** LLM calls — they live in state and prompt construction, not in extra model calls. `runAgent` never throws: on error it returns a usable message with the failure flagged in `meta`.

### Personality — consistent and variable
The **voice profile** (formality, emoji policy, language) is derived deterministically from the company's `voice` fields, so it stays stable across the conversation. The **narrative persona** is synthesized once and cached by a hash of the company context — which is exactly why the personality stays consistent within a conversation and **visibly changes when the context changes**. Style feedback from the candidate ("less jargon") layers on top without altering the base persona. Formality is anchored to the brand; it never drops because the candidate writes casually.

### Two-sided memory + constraint lifecycle (the feedback loop)
The agent remembers, on the **candidate side**, everything they reject / constrain / dismiss / answer / criticize; on its **own side**, every point it has made, question it has asked, and proposal it has floated — so it never repeats itself. Constraints have a **lifecycle**: when a candidate *reverses* ("actually backend could work if I also touch product"), the entry is retracted or softened — not silently dropped — and the trace shows it. This is the feedback loop running in both directions, and it costs no extra LLM call.

### Measured trace, not declared
The reasoning trace shown in the test area (signals, decision, constraints respected, repetition avoided) is **derived from the message that actually gets sent**, not asserted by the planner — so a "✓ did not push a call" only appears if the sent message really doesn't. A trace that contradicts the message would be worse than no trace.

## Engineering choices

- **2 calls, not 4.** An earlier design split signal-analysis, planning, writing, and verification into separate calls. Each extra call is latency, cost, and a new failure mode. Reasoning and signal extraction are one cognitive act, so they're one structured call; verification is deterministic by default. The sophistication lives in the **state model**, not in the call count.
- **No database.** The test area is ephemeral by design; state round-trips through the client as `priorState` (validated at runtime), with a `StateStore` seam left in place to swap in Postgres/KV for cross-session persistence later. An LLM has no memory regardless of storage — the memory *is* the state structure, not the backend.
- **Planner / writer split; writer goal-blind.** Separating *deciding* from *writing* makes the strategy inspectable and the prose constrained. Hiding the global goal from the writer is what stopped it pushing calls prematurely.
- **Untrusted candidate input.** The reply is treated as data, never instructions: delimiter tokens are neutralized, and the persona / goal / constraints can't be overridden by message content (anti-injection).
- **Internal English, external conversation-language.** The agent reasons and stores memory in English (the operator-facing trace is always English); the candidate-facing message follows the conversation's language — mirrored from the candidate, switching only on a clear, sustained change.

## Try it

1. Open the demo → **/configure** → fill in a company context (or use the prefilled example).
2. Go to **/test**. The agent produces its opening message, its self-assigned persona, its plan, and a live reasoning trace.
3. **Reply as the candidate** — push back, raise objections, change your mind — and watch the plan, memory, and next message adapt. Nothing is actually sent.

Run locally:
```bash
npm install
echo "ANTHROPIC_API_KEY=sk-..." > .env.local
npm run dev
```

## Testing

- `npm run eval` — a regression suite (17 boolean assertions against the real engine) covering the graded properties and every bug found in live testing: scheduling-gate, no-stub recovery, conversation continuity, language, placeholders, decision-adherence, measured-trace accuracy, anti-repetition, and clean disengagement.
- `npm run agent:try -- --scenario fixtures/X.json` — runs the engine **in isolation, no UI**: a company context + intent + a simulated reply in, the full structured `AgentOutput` out.

## Stack

Next.js (App Router) + TypeScript · agent as a **server-only module** (the API key never reaches the client) · Anthropic API — `claude-sonnet-4-6` for reason/write, a Haiku-class model for the lightweight adherence check · Zod for runtime schema validation · deployed on Vercel.

## Known debt / next steps

- **Rule consolidation** — each detection rule (scheduling, language, greeting, register) is currently expressed in 3–4 places; consolidating into `Rule { detect, repair, promptHint }` objects would dissolve the large `verify.ts` module.
- **Account-scoped persistence** — via the existing `StateStore` seam: persist `CompanyContext` and per-candidate `AgentState` so the agent resumes after reconnection, with auth to scope it.
- **CV ingestion** — the seam already exists (`candidate.notes` flows into REASON as grounding); the productized version parses an uploaded CV into candidate facts.
- **Multi-message turns** — let the agent send 2–3 short consecutive messages (and the candidate too) for more natural pacing.
