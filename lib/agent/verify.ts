import { z } from "zod";
import type { ChannelHint, NextMessage, VoiceProfile } from "./types";
import type { ForbiddenList } from "./grounding";
import { callStructured } from "./llm";
import { MODELS, MAX_TOKENS, TIMEOUTS } from "./config";

// © ® ™ sont Extended_Pictographic mais PAS des emojis : on les exclut.
const NON_EMOJI = new Set([0xa9, 0xae, 0x2122]);
function hasEmoji(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && NON_EMOJI.has(cp)) continue;
    if (/\p{Extended_Pictographic}/u.test(ch)) return true;
  }
  return false;
}

// Présence d'un terme : pour un mot unique on borne sur les frontières de mot
// (évite les faux positifs « ai » dans « travail »); pour une expression on garde
// le substring (faible risque de collision).
function containsTerm(hayLower: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  if (/^[\p{L}\p{N}]+$/u.test(t)) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(t)}(?![\\p{L}\\p{N}])`, "u").test(hayLower);
  }
  return hayLower.includes(t);
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DeterministicCtx {
  forbidden: ForbiddenList;
  voiceProfile: VoiceProfile;
  channelHint: ChannelHint;
  bodyLimit: number; // limite DURE de caractères (canal + hook/answer)
}

// VERIFY est déterministe par DÉFAUT. On ne paie l'appel LLM que si c'est AMBIGU :
// le message partage un mot significatif avec un sujet banni / une info connue
// sans avoir été attrapé par le check littéral → reproposition/re-demande possible.
// Sinon (cas courant) : pas de 3e appel → meta.llmCallsFired = 2 sur un tour de réaction.
function sigTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/\p{L}{4,}/gu) ?? []));
}
export function needsLlmVerify(msg: NextMessage, forbidden: ForbiddenList): boolean {
  const body = sigTokens(`${msg.subject ?? ""} ${msg.body}`);
  if (body.size === 0) return false;
  const risky = [...forbidden.bannedTopics, ...forbidden.knownFacts];
  for (const item of risky) {
    for (const tok of sigTokens(item)) {
      if (body.has(tok)) return true;
    }
  }
  return false;
}

// CHECKS DURS EN CODE — rapides, sans LLM. Renvoie la liste des violations.
export function deterministicChecks(msg: NextMessage, ctx: DeterministicCtx): string[] {
  const violations: string[] = [];
  const haystack = `${msg.subject ?? ""}\n${msg.body}`;
  const lower = haystack.toLowerCase();

  // 1) Termes proscrits (dontSay).
  for (const term of ctx.forbidden.dontSay) {
    if (containsTerm(lower, term)) violations.push(`Terme proscrit présent : « ${term} ».`);
  }

  // 2) Politique emoji.
  if (ctx.voiceProfile.emojiUse === "none" && hasEmoji(haystack)) {
    violations.push("Emoji présent alors que la politique est 'none'.");
  }

  // 3) Longueur cohérente avec le canal (limite DURE passée par l'orchestrateur).
  if (msg.body.length > ctx.bodyLimit) {
    violations.push(`Body trop long (${msg.body.length} > ${ctx.bodyLimit} pour ${ctx.channelHint}).`);
  }
  if (msg.body.trim().length === 0) violations.push("Body vide.");

  // 3b) Placeholders entre crochets interdits ([First Name], [Your Name], …).
  const bracket = haystack.match(/\[[^\]\n]{1,40}\]/);
  if (bracket) violations.push(`Placeholder entre crochets interdit : « ${bracket[0]} ».`);

  // 4) Mémoire : reproposition d'un sujet banni (rejet/écarté actif).
  for (const topic of ctx.forbidden.bannedTopics) {
    if (containsTerm(lower, topic)) violations.push(`Repropose un sujet banni : « ${topic} ».`);
  }

  // 5) Anti-répétition : question déjà posée re-posée verbatim.
  //    (pointsMade = directives de planification abstraites : non vérifiables par substring
  //     — laissées au writer comme garde-fou + au VERIFY LLM sémantique.)
  for (const q of ctx.forbidden.questionsAsked) {
    if (q && lower.includes(q.toLowerCase())) {
      violations.push(`Re-pose une question déjà posée : « ${q} ».`);
    }
  }

  // 6) Registre casual = chaleureux mais PROPRE (jamais ado/texto).
  if (ctx.voiceProfile.formality === "casual") {
    const opening = msg.body.trimStart();
    if (/^(yo\b|hey\s+yo\b|wesh\b|coucou\b)/i.test(opening)) {
      violations.push("Ouverture trop familière/ado en casual (Yo/Hey yo/Wesh/Coucou).");
    }
    for (const slang of ["ouais", "grave", "chiant", "trop stylé"]) {
      if (containsTerm(lower, slang)) violations.push(`Argot proscrit en casual : « ${slang} ».`);
    }
    if (haystack.includes("!!!") || haystack.includes("???")) {
      violations.push("Ponctuation excessive (!!! / ???) — pas en casual propre.");
    }
  }

  return violations;
}

const VerifyOutputSchema = z.object({
  pass: z.boolean(),
  violations: z.array(z.string()),
});

export interface LlmVerifyResult {
  pass: boolean;
  violations: string[];
  ok: boolean; // l'appel LLM a-t-il abouti
  calls: number;
}

// VERIFY LLM (modèle léger) — n'attrape QUE le sémantique que le code rate :
// reproposition proche d'un rejet, re-demande d'une info connue, re-soulèvement
// d'un sujet écarté, répétition d'un point. Appelé seulement si le code passe.
export async function llmVerify(
  msg: NextMessage,
  forbidden: ForbiddenList,
): Promise<LlmVerifyResult> {
  const needsCheck =
    forbidden.bannedTopics.length ||
    forbidden.knownFacts.length ||
    forbidden.pointsMade.length ||
    forbidden.questionsAsked.length;
  if (!needsCheck) return { pass: true, violations: [], ok: true, calls: 0 };

  const system = [
    "Tu es un vérificateur strict. On te donne un message et une liste d'interdits.",
    "Détecte UNIQUEMENT : reproposition (même de loin) d'un sujet banni, re-demande d'une",
    "info déjà connue, re-soulèvement d'un sujet écarté, ou répétition d'un argument déjà servi.",
    "Si rien de tout cela : pass=true. Sinon pass=false et liste les violations. Réponds via le tool.",
  ].join(" ");

  const user = [
    "MESSAGE :",
    `subject: ${msg.subject ?? "(aucun)"}`,
    `body: ${msg.body}`,
    "",
    "INTERDITS :",
    `sujets bannis: ${JSON.stringify(forbidden.bannedTopics)}`,
    `infos connues (ne pas re-demander): ${JSON.stringify(forbidden.knownFacts)}`,
    `arguments déjà servis: ${JSON.stringify(forbidden.pointsMade)}`,
    `questions déjà posées: ${JSON.stringify(forbidden.questionsAsked)}`,
  ].join("\n");

  const res = await callStructured({
    model: MODELS.verify,
    system,
    user,
    toolName: "verdict",
    toolDescription: "Rend un verdict pass/violations sur le respect de la mémoire.",
    schema: VerifyOutputSchema,
    maxTokens: MAX_TOKENS.verify,
    timeoutMs: TIMEOUTS.verify,
  });

  if (res.ok) {
    return { pass: res.value.pass, violations: res.value.violations, ok: true, calls: res.calls };
  }
  // Si le vérificateur LLM échoue, on ne BLOQUE pas (le code a déjà passé) : on laisse passer.
  return { pass: true, violations: [], ok: false, calls: res.calls };
}
