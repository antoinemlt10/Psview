# PSVIEW — autonomous recruiting agent (site + form + test area + engine)

A mini web app where you capture a company's context once, and an autonomous
recruiting agent **configures itself** from it: it gives itself a personality,
writes itself a plan, and engages a candidate — reading replies and deciding what
to do next. No real messages are sent; the test area is a live preview.

**This is the single, canonical repo for the project** — it contains the UI
(site + form + test area), the route, **and the real reasoning engine**
(`lib/agent/*`, powered by the Anthropic API), plus the isolation CLI and the
eval harness. There is no longer a separate engine repo or a stub: the deployed
engine *is* the tested engine. (An earlier `psview-agent` repo held the engine
origin; it is now superseded by this repo and out of scope.)

## What's in here

- **`/`** — landing: the thesis, the 3-step flow, and a live reasoning panel as the hero visual.
- **`/configure`** — the context form: Identity, Culture, Hiring (multiple roles, add/remove), Voice. Chip inputs for arrays, segmented controls for enums, a "Load sample (PSVIEW)" button, and `name`-required validation. Saves to `localStorage`, redirects to `/test`.
- **`/test`** — loads the context, auto-generates the opening message, shows the persona (in serif), the conversation thread (agent left, candidate right), an editable intent, a "reply as the candidate" composer, and **the reasoning panel** — signals, decision, plan stepper, grounding.
- **`POST /api/agent`** — stateless seam: takes an `AgentInput`, returns an `AgentOutput`. Calls the **real engine** (`lib/agent/runAgent`).
- **`lib/agent/*`** — the reasoning engine: 2-LLM-call hot path (REASON → deterministic gates → WRITE → VERIFY), two-sided memory with a constraint lifecycle, deterministic language/scheduling/greeting/register/markdown gates, never-throw orchestrator.
- **`eval/`, `fixtures/`, `scripts/`** — boolean eval harness (`npm run eval`), A/B/C/D scenarios, and the isolation CLI (`npm run agent:try`).

## Architecture

State lives on the **client** (`CompanyContext` + conversation + the engine's rich
`AgentState` in `localStorage`). The agent is a **stateless endpoint**: the full
state round-trips via `AgentOutput.state` ↔ `AgentInput.priorState` (validated at
runtime in the engine, since the blob is untrusted client data).

```
/configure --(localStorage CompanyContext)--> /test --(AgentInput)--> POST /api/agent --(runAgent)--> persona + thread + reasoning
```

**One shared contract, one definition.** The single source of truth is
**`lib/agent/types.ts`**; the UI imports the same types via a thin façade
(`lib/types.ts` re-exports them). There is no duplicate type family and no
`as unknown as` adapter — the route returns the engine's `AgentOutput` directly.

> **Internal layer is English.** All reasoning/memory/trace (signals, decision,
> plan objectives, memory entries) is produced and stored in English regardless of
> the conversation language; only the candidate-facing `nextMessages[]` follow the
> conversation's language.

## Choices

- **Next.js 14.2.35 (App Router) + React 18 + TypeScript + Tailwind v3.4**, deployed on Vercel. One app, one repo, one URL.
- **Fonts via the `geist` npm package** (self-hosted Geist Sans + Mono) — *not* `next/font/google`, whose build-time network fetch is fragile. The agent's "voice" uses a **system serif stack** (Iowan Old Style → Palatino → Georgia), zero fetch.
- **Next pinned to 14.2.35** (earlier 14.2.x has a security advisory).
- **The typography encodes the concept**: product chrome in grotesk (Geist), the agent's **voice** (persona + messages) in serif, **data/reasoning** in Geist Mono. One accent — deep ultramarine `#2f27ce` = signal/intelligence — used sparingly on a warm-neutral `#f6f6f4` canvas.

## What makes the agent intelligent — and not just an LLM call?

**The loop, not the text generation.** On every turn the engine runs an explicit
**reason → decide → act** cycle over persistent two-sided memory and a plan:

1. **Perceive** — REASON reads the candidate's reply, extracts typed *signals* and emits *memory ops* (rejections / constraints / objections / facts / dismissed topics / style feedback, plus reversals when the candidate walks something back).
2. **Decide** — deterministic invariants then constrain the next move (stage gates, interest gate before proposing a call, no re-intro with history) — the same input at a different stage produces a different move.
3. **Act** — WRITE composes a message **grounded in named context fields** and a forbidden-list (active rejections, known facts, points already made), then VERIFY repairs it deterministically (language / scheduling / greeting / register / markdown) and an LLM proofread checks coherence + native grammar. The trace reports exactly which fields and constraints were used (`groundingUsed`, `constraintsRespected`, `avoidedRepetition`).

So the intelligence is the **plan + memory + grounding + the perceive/decide/act
loop with deterministic gates** — an architecture the LLM *fills in*, not one it
replaces. The personality is *derived* from context and **changes when the context
changes**; messages reflect the *real* company, not generic copy.

## Run

```bash
npm install
cp .env.example .env.local   # set ANTHROPIC_API_KEY (server-only; never shipped to the client)
npm run dev        # http://localhost:3000
npm run build      # type-checks + production build

npm run eval       # boolean eval harness over A/B/C/D scenarios (real LLM calls)
npm run agent:try  # isolation CLI — run the engine without the UI
```

Try it: open `/configure` → "Load sample (PSVIEW)" → "Save & test". On `/test`,
reply as the candidate with something like *"interesting but I'm swamped this
quarter"* and watch the reasoning panel switch to the `handle_objection` stage.

Or hit the endpoint directly:

```bash
curl -s localhost:3000/api/agent -X POST -H 'content-type: application/json' \
  -d '{"companyContext":{"identity":{"name":"PSVIEW","oneLiner":"autonomous AI recruiting agents","industry":"AI","sizeStage":"seed"},"culture":{"values":["Ownership"],"cultureNotes":""},"hiring":{"roles":[{"title":"Founding Engineer","seniority":"senior","whatTheyllDo":"own product end-to-end","mustHaveSkills":["TypeScript"]}],"idealCandidateTraits":[]},"voice":{"tone":"warm and direct","formality":"neutral","language":"en","emojiUse":"sparing"}},"intent":"engage and book a call","conversation":[],"incomingCandidateReply":"sounds good but I’m swamped this quarter"}'
```

## Deploy (Vercel)

1. Push this folder to a GitHub repo.
2. Import it in Vercel — it auto-detects Next.js, no config needed.
3. Set `ANTHROPIC_API_KEY` in the Vercel project env (Server only). The key is
   read server-side in `lib/agent/llm.ts` and never reaches the client.
4. Deploy. `/api/agent` runs on the Node.js runtime (`force-dynamic`).

## Known debt / next refactors

Surfaced by an adversarial review; deliberately deferred to keep this change
focused. None of these block correctness today.

- **Detection logic is expressed in 3–4 places (#2).** Each gate (scheduling /
  language / greeting / register) lives in the writer prompt (instruction), in
  `verify.ts` `deterministicChecks` (detection), and in `repairMessage`
  (excision) — and the casual slang list is duplicated between detect and repair.
  These must be kept in sync by hand. Next refactor: one `Rule { detect, repair,
  promptHint }` object per gate so detection/repair/prompt can't drift.
- **`verify.ts` is a god-module (~470 lines).** Five rule families + detect +
  repair + the LLM proofread in one file. Splitting per the rule refactor above
  dissolves it (`rules/language.ts`, `rules/scheduling.ts`, … + `proofread.ts`).
- **`runAgent.ts` is one large orchestrator function (#4).** The language
  resolution and the verify/repair/regenerate loop are inlined. Extract
  `resolveTurnLanguage`, `buildVerifyContext`, and `runVerifyLoop` so the
  orchestrator just sequences named stages (and becomes unit-testable).
- **`StateStore` seam is unused by the app.** It's an intentional persistence
  seam (swap the client round-trip for Postgres/KV later) but nothing calls it
  today; wire it server-side or remove it when the persistence story is decided.
