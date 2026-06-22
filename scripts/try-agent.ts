/**
 * CLI de test en isolation.
 *   npm run agent:try -- --scenario fixtures/A.json
 *
 * Charge { companyContext, intent, candidate?, conversation, incomingCandidateReply?, priorState? },
 * appelle runAgent, et pretty-print persona + plan + trace + message + meta.
 * Pour enchaîner les tours : copie le bloc "state" affiché dans priorState du scénario suivant.
 */
import { readFileSync } from "node:fs";
import type { AgentInput } from "../lib/agent/types";
import { runAgent } from "../lib/agent/runAgent";

// Charge .env.local pour la clé ANTHROPIC_API_KEY (hors runtime Next).
try {
  process.loadEnvFile(".env.local");
} catch {
  /* pas de .env.local : on suppose la variable déjà dans l'env */
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const H = (s: string) => `\n\x1b[1m\x1b[36m${s}\x1b[0m`;
const list = (items?: string[]) =>
  items && items.length ? items.map((x) => `  • ${x}`).join("\n") : "  (aucun)";

async function main() {
  const scenario = arg("--scenario");
  if (!scenario) {
    console.error("Usage: npm run agent:try -- --scenario fixtures/A.json");
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(scenario, "utf8")) as AgentInput;
  console.log(H(`▶ Scénario : ${scenario}`));
  console.log(`intent : ${input.intent}`);
  console.log(`entreprise : ${input.companyContext.identity.name}`);
  if (input.incomingCandidateReply) console.log(`réponse candidat : "${input.incomingCandidateReply}"`);

  const out = await runAgent(input);

  console.log(H("PERSONA"));
  console.log(out.personality.persona);
  console.log(`traits : ${out.personality.traits.join(", ")}`);
  console.log(
    `voix : formality=${out.personality.voiceProfile.formality}, emoji=${out.personality.voiceProfile.emojiUse}, langue=${out.personality.voiceProfile.language}`,
  );
  if (out.personality.voiceProfile.styleAdjustments.length)
    console.log(`ajustements de style :\n${list(out.personality.voiceProfile.styleAdjustments)}`);

  console.log(H("PLAN"));
  console.log(`goal : ${out.plan.goal}`);
  console.log(`étape courante : ${out.plan.currentStage}`);

  console.log(H("TRACE (raisonnement)"));
  console.log(`décision : ${out.reasoning.decision}`);
  console.log("signaux :");
  console.log(list(out.reasoning.candidateSignals));
  console.log("ancrage utilisé :");
  console.log(list(out.reasoning.groundingUsed));
  console.log("contraintes respectées :");
  console.log(list(out.reasoning.constraintsRespected));
  console.log("anti-répétition :");
  console.log(list(out.reasoning.avoidedRepetition));
  console.log("mises à jour mémoire :");
  console.log(list(out.reasoning.memoryUpdates));

  console.log(H(`MESSAGE${out.nextMessages.length > 1 ? `S (${out.nextMessages.length})` : ""}`));
  out.nextMessages.forEach((m, i) => {
    if (out.nextMessages.length > 1) console.log(`— message ${i + 1} —`);
    console.log(`canal : ${m.channelHint}`);
    if (m.subject) console.log(`objet : ${m.subject}`);
    console.log(m.body);
  });

  console.log(H("META"));
  console.log(JSON.stringify(out.meta, null, 2));

  console.log(H("STATE (à réinjecter dans priorState pour le tour suivant)"));
  console.log(JSON.stringify(out.state));
}

main().catch((e) => {
  console.error("Erreur CLI :", e);
  process.exit(1);
});
