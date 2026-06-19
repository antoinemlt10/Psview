# PSVIEW — recruiting agent (site + form + test area)

A mini web app where you capture a company's context once, and an autonomous
recruiting agent **configures itself** from it: it gives itself a personality,
writes itself a plan, and engages a candidate — reading replies and deciding what
to do next. No real messages are sent; the test area is a live preview.

This repo is the **site + form + test-area** half of the build. The reasoning
engine lives in a separate workstream and plugs in through one endpoint. Until
then the app runs on a **deterministic stub** that honours the exact contract, so
everything is demo-able today.

## What's in here

- **`/`** — landing: the thesis, the 3-step flow, and a live reasoning panel as the hero visual.
- **`/configure`** — the context form: Identity, Culture, Hiring (multiple roles, add/remove), Voice. Chip inputs for arrays, segmented controls for enums, a "Load sample (PSVIEW)" button, and `name`-required validation. Saves to `localStorage`, redirects to `/test`.
- **`/test`** — loads the context, auto-generates the opening message, shows the persona (in serif), the conversation thread (agent left, candidate right), an editable intent, a "reply as the candidate" composer, and **the reasoning panel** — signals, decision, plan stepper, grounding.
- **`POST /api/agent`** — stateless seam: takes an `AgentInput`, returns an `AgentOutput`. Calls the stub today; the real engine later.

## Architecture

State lives on the **client** (`CompanyContext` + conversation in `localStorage`).
The agent is a **stateless endpoint**. The real engine replaces the stub without
touching anything else.

```
/configure --(localStorage CompanyContext)--> /test --(AgentInput)--> POST /api/agent --(AgentOutput)--> persona + thread + reasoning
```

The shared contract is in **`lib/types.ts`** — the single source of truth between
the form (producer) and the agent (consumer). Keep it synced with the engine workstream.

## Choices

- **Next.js 14.2.35 (App Router) + React 18 + TypeScript + Tailwind v3.4**, deployed on Vercel. One app, one repo, one URL.
- **Fonts via the `geist` npm package** (self-hosted Geist Sans + Mono) — *not* `next/font/google`, whose build-time network fetch is fragile. The agent's "voice" uses a **system serif stack** (Iowan Old Style → Palatino → Georgia), zero fetch.
- **Next pinned to 14.2.35** (earlier 14.2.x has a security advisory).
- **The typography encodes the concept**: product chrome in grotesk (Geist), the agent's **voice** (persona + messages) in serif, **data/reasoning** in Geist Mono. One accent — deep ultramarine `#2f27ce` = signal/intelligence — used sparingly on a warm-neutral `#f6f6f4` canvas.

## What makes the agent intelligent — and not just an LLM call?

**The loop, not the text generation.** On every turn the stub runs an explicit
**reason → decide → act** cycle over a persistent plan and state:

1. **Perceive** — it reads the candidate's reply and extracts typed *signals* (interested / objection:timing / objection:compensation / objection:not-looking / question).
2. **Decide** — those signals drive a *state transition* across an explicit funnel (`open → qualify → handle → book`). The same input at a different stage produces a different move.
3. **Act** — it composes a message **grounded in named context fields** (`identity.name`, `culture.values[0]`, the role + its skills, `voice.tone`), respects `emojiUse`, and scrubs the `dontSay` list. It then reports exactly which fields it used (`groundingUsed`).

So the intelligence is the **plan + state + grounding + the perceive/decide/act
loop** — an architecture an LLM call *fills in*, not one it replaces. The personality
is *derived* from context (tone + values) and **changes when the context changes**;
messages reflect the *real* company, not generic copy. Swapping the stub for a real
model upgrades step 3's fluency without changing the architecture that makes it an agent.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # type-checks + production build
```

Try it: open `/configure` → "Load sample (PSVIEW)" → "Save & test". On `/test`,
reply as the candidate with something like *"interesting but I'm swamped this
quarter"* and watch the reasoning panel switch to the `handle` stage.

Or hit the endpoint directly:

```bash
curl -s localhost:3000/api/agent -X POST -H 'content-type: application/json' \
  -d '{"companyContext":{"identity":{"name":"PSVIEW","oneLiner":"autonomous AI recruiting agents","industry":"AI","sizeStage":"seed"},"culture":{"values":["Ownership"],"cultureNotes":""},"hiring":{"roles":[{"title":"Founding Engineer","seniority":"senior","whatTheyllDo":"own product end-to-end","mustHaveSkills":["TypeScript"]}],"idealCandidateTraits":[]},"voice":{"tone":"warm and direct","formality":"neutral","language":"en","emojiUse":"sparing"}},"intent":"engage and book a call","conversation":[],"incomingCandidateReply":"sounds good but I’m swamped this quarter"}'
```

## Deploy (Vercel)

1. Push this folder to a GitHub repo.
2. Import it in Vercel — it auto-detects Next.js, no config needed.
3. Deploy. The stub needs no env vars; the app is fully usable immediately.

## Plugging in the real agent

1. `npm i @anthropic-ai/sdk` and set `ANTHROPIC_API_KEY` (see `.env.example`).
2. Add `lib/agent.ts` exporting `export async function runAgent(input: AgentInput): Promise<AgentOutput>`.
3. In `app/api/agent/route.ts`, swap `runAgentStub` for `runAgent`.

Nothing else changes — same contract, same UI.
