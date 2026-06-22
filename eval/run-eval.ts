/**
 * Harnais d'eval : assertions BOOLÉENNES sur les scénarios A/B/C/D.
 *   npm run eval
 * Nécessite ANTHROPIC_API_KEY (les appels LLM sont réels).
 */
import { readFileSync } from "node:fs";
import type { AgentInput, AgentOutput, MemoryEntry } from "../lib/agent/types";
import { runAgent } from "../lib/agent/runAgent";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* clé supposée déjà dans l'env */
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("✗ ANTHROPIC_API_KEY manquante. Mets-la dans .env.local puis relance `npm run eval`.");
  process.exit(1);
}

const load = (p: string): AgentInput => JSON.parse(readFileSync(p, "utf8")) as AgentInput;

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];
const assert = (name: string, pass: boolean, detail?: string) =>
  checks.push({ name, pass, detail });

const norm = (s: string) => s.toLowerCase();
const bodyOf = (o: AgentOutput) =>
  norm(o.nextMessages.map((m) => `${m.subject ?? ""}\n${m.body}`).join("\n"));
const active = (es: MemoryEntry[]) => es.filter((e) => e.status === "active");

async function main() {
  const A = load("fixtures/A.json");
  const B = load("fixtures/B.json");
  const C = load("fixtures/C.json");
  const D = load("fixtures/D.json");

  console.log("Exécution des scénarios (appels LLM réels)…");
  const a1 = await runAgent(A);
  const a2 = await runAgent(A); // même contexte → persona stable (caché)
  const b = await runAgent(B);
  const c = await runAgent(C);
  const d = await runAgent(D);

  // ── Personnalité ──
  assert(
    "A: persona STABLE sur le même contexte (2 runs identiques)",
    a1.personality.persona === a2.personality.persona &&
      a1.state.personaKey === a2.state.personaKey,
  );
  assert(
    "A vs C: persona VISIBLEMENT DIFFÉRENT quand le contexte change",
    a1.state.personaKey !== c.state.personaKey &&
      a1.personality.persona !== c.personality.persona,
  );
  assert(
    "C: voiceProfile dérivé du contexte (casual + emoji liberal)",
    c.personality.voiceProfile.formality === "casual" &&
      c.personality.voiceProfile.emojiUse === "liberal",
  );

  // ── Ancrage ──
  assert(
    "A: ancrage présent dans la trace",
    a1.reasoning.groundingUsed.length > 0,
    a1.reasoning.groundingUsed.join(" | "),
  );
  assert(
    "A: le message cite un champ concret (nom d'entreprise ou rôle)",
    bodyOf(a1).includes(norm(A.companyContext.identity.name)) ||
      bodyOf(a1).includes(norm(A.companyContext.hiring.roles[0].title)),
  );

  // ── Branche objection ──
  assert(
    "B: réticence candidat → branche handle_objection",
    b.plan.currentStage === "handle_objection",
    `stage=${b.plan.currentStage}`,
  );

  // ── dontSay jamais présent ──
  for (const [label, input, out] of [
    ["A", A, a1],
    ["B", B, b],
    ["C", C, c],
    ["D", D, d],
  ] as const) {
    const banned = input.companyContext.voice.dontSay ?? [];
    const present = banned.filter((t) => bodyOf(out).includes(norm(t)));
    assert(`${label}: aucun terme dontSay dans le message`, present.length === 0, present.join(", "));
  }

  // ── Rejet actif jamais reproposé (sur les rejets restés actifs en sortie) ──
  for (const [label, out] of [
    ["A", a1],
    ["B", b],
    ["C", c],
  ] as const) {
    const stillActive = active(out.state.candidateMemory.rejections);
    const reproposed = stillActive.filter((e) => bodyOf(out).includes(norm(e.content)));
    assert(`${label}: aucun rejet ACTIF reproposé`, reproposed.length === 0);
  }

  // ── Réversion (D) : la contrainte cesse d'être enforced ──
  const backend = d.state.candidateMemory.rejections.find((e) => e.id === "rej_t2_0");
  assert(
    "D: réversion appliquée — le rejet backend n'est plus 'active'",
    !!backend && backend.status !== "active",
    `status=${backend?.status}`,
  );

  // ── Anti-répétition (D) : question déjà posée non re-posée, point déjà fait non répété ──
  const priorQ = D.priorState?.agentMemory.questionsAsked ?? [];
  assert(
    "D: question déjà posée non re-posée (verbatim)",
    priorQ.every((q) => !bodyOf(d).includes(norm(q))),
  );
  const priorP = D.priorState?.agentMemory.pointsMade ?? [];
  assert(
    "D: argument déjà servi non répété (verbatim)",
    priorP.every((p) => !bodyOf(d).includes(norm(p))),
  );

  // ── Info connue non re-demandée (D : éviter de re-poser la question de découverte) ──
  assert(
    "D: la trace expose la boucle (constraintsRespected ou avoidedRepetition non vide)",
    d.reasoning.constraintsRespected.length > 0 || d.reasoning.avoidedRepetition.length > 0,
  );

  // ── Récap ──
  console.log("\n──────── RÉCAP EVAL ────────");
  let failed = 0;
  for (const c of checks) {
    const tag = c.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`${tag}  ${c.name}${c.detail ? `  — ${c.detail}` : ""}`);
    if (!c.pass) failed++;
  }
  console.log(`────────────────────────────`);
  console.log(`${checks.length - failed}/${checks.length} OK, ${failed} échec(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur eval :", e);
  process.exit(1);
});
