import { z } from "zod";
import type { ChannelHint, NextMessage, VoiceProfile } from "./types";
import type { ForbiddenList } from "./grounding";
import { callStructured } from "./llm";
import { MODELS, MAX_TOKENS, TIMEOUTS } from "./config";
import { truncateToSentence, fallbackLang } from "./write";

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
export function containsTerm(hayLower: string, term: string): boolean {
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

// Détecte un langage de SCHEDULING (appel, créneau, horaire, jour, lien d'agenda) — fr+en.
// Stems en préfixe (pas de \b final) pour attraper "available/scheduling/disponibilités/créneaux".
const SCHEDULING_RE =
  /\b(?:appel|rdv|rendez-?vous|cr[ée]neau|planifi|disponib|dispo|agenda|calend|call|meeting|schedul|slot|availab|calendly|cal\.com|zoom|lundi|mardi|mercredi|jeudi|vendredi|monday|tuesday|wednesday|thursday|friday)|\b\d{1,2}\s?(?:h|am|pm)\b|\b\d{1,2}:\d{2}\b/i;
export function hasSchedulingLanguage(text: string): boolean {
  return SCHEDULING_RE.test(text);
}

export interface DeterministicCtx {
  forbidden: ForbiddenList;
  voiceProfile: VoiceProfile;
  channelHint: ChannelHint;
  bodyLimit: number; // limite DURE de caractères (canal + hook/answer)
  schedulingAllowed: boolean; // proposition d'appel/créneau autorisée ce tour ?
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

  // 3c) Stage-gate du scheduling : pas de proposition d'appel/créneau hors-stage.
  if (!ctx.schedulingAllowed && hasSchedulingLanguage(haystack)) {
    violations.push("Proposition d'appel/créneau hors-stage (scheduling non autorisé ce tour).");
  }

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

  // 6b) PLANCHER DE FORMALITÉ : en formal/neutral, pas d'ouverture décontractée
  //     (Salut/Coucou/Yo/Hey/Wesh) — la familiarité du candidat ne baisse pas le niveau.
  if (ctx.voiceProfile.formality !== "casual") {
    const opening = msg.body.trimStart();
    if (/^(salut\b|coucou\b|yo\b|hey\b|wesh\b)/i.test(opening)) {
      violations.push(
        `Ouverture trop décontractée pour le niveau « ${ctx.voiceProfile.formality} » (plancher de formalité).`,
      );
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

export interface AdherenceCtx {
  decision: string;
  mustDo: string[];
  mustNotDo: string[];
  avoidedRepetition: string[]; // ce que REASON s'était engagé à éviter
}

// VERIFY LLM (modèle léger) — deux vérifications sémantiques que le code rate :
//  (a) MÉMOIRE : reproposition proche d'un rejet, re-demande d'une info connue, redite ;
//  (b) ADHÉRENCE : le message FINAL a-t-il exécuté la décision (mustDo) et évité les
//      mustNotDo / répétitions promises ? Divergence → violations → révision.
export async function llmVerify(
  msg: NextMessage,
  forbidden: ForbiddenList,
  adherence?: AdherenceCtx,
): Promise<LlmVerifyResult> {
  const needsMemory =
    forbidden.bannedTopics.length ||
    forbidden.knownFacts.length ||
    forbidden.pointsMade.length ||
    forbidden.questionsAsked.length;
  const needsAdherence =
    !!adherence && (adherence.mustDo.length > 0 || adherence.mustNotDo.length > 0);
  if (!needsMemory && !needsAdherence) return { pass: true, violations: [], ok: true, calls: 0 };

  const system = [
    "Tu es un vérificateur strict du message FINAL d'un agent de recrutement.",
    "(A) MÉMOIRE : détecte toute reproposition (même de loin) d'un sujet banni, re-demande d'une",
    "info déjà connue, re-soulèvement d'un sujet écarté, ou répétition d'un argument déjà servi.",
    "(B) ADHÉRENCE : le message exécute-t-il CHAQUE point de À FAIRE ? Évite-t-il TOUT À NE PAS FAIRE",
    "et toute répétition listée ? Une divergence (point À FAIRE manquant, ou À NE PAS FAIRE présent,",
    "ex: re-décrit le rôle, re-présente des excuses, pousse un appel) = violation.",
    "Si tout est respecté : pass=true. Sinon pass=false + violations précises. Réponds via le tool.",
  ].join(" ");

  const user = [
    "MESSAGE FINAL :",
    `subject: ${msg.subject ?? "(aucun)"}`,
    `body: ${msg.body}`,
    "",
    "INTERDITS MÉMOIRE :",
    `sujets bannis: ${JSON.stringify(forbidden.bannedTopics)}`,
    `infos connues (ne pas re-demander): ${JSON.stringify(forbidden.knownFacts)}`,
    `arguments déjà servis: ${JSON.stringify(forbidden.pointsMade)}`,
    `questions déjà posées: ${JSON.stringify(forbidden.questionsAsked)}`,
    ...(adherence
      ? [
          "",
          "DÉCISION À AVOIR EXÉCUTÉE :",
          adherence.decision,
          `À FAIRE: ${JSON.stringify(adherence.mustDo)}`,
          `À NE PAS FAIRE: ${JSON.stringify(adherence.mustNotDo)}`,
          `RÉPÉTITIONS À ÉVITER: ${JSON.stringify(adherence.avoidedRepetition)}`,
        ]
      : []),
  ].join("\n");

  const res = await callStructured({
    model: MODELS.verify,
    system,
    user,
    toolName: "verdict",
    toolDescription: "Rend un verdict pass/violations sur la mémoire ET l'adhérence à la décision.",
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

// ── RÉPARATION CHIRURGICALE DÉTERMINISTE (0 LLM) ──
// Au lieu de régénérer-puis-stub sur une violation réparable, on EXCISE la cause :
// phrases de scheduling hors-stage, sujets bannis, questions déjà posées ;
// placeholders, termes proscrits, dérives casual, emojis ; troncature pour la
// longueur. Le hook + la question survivent. Déterministe → converge en 1 passe.
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}
function stripEmojiChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && NON_EMOJI.has(cp)) {
      out += ch;
      continue;
    }
    if (/\p{Extended_Pictographic}/u.test(ch)) continue;
    out += ch;
  }
  return out;
}
function tidy(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function repairMessage(msg: NextMessage, ctx: DeterministicCtx): NextMessage {
  let body = msg.body;
  let subject = msg.subject;

  const dropSentence = (pred: (s: string) => boolean) => {
    body = splitSentences(body)
      .filter((s) => s.trim() && !pred(s))
      .join(" ");
  };

  // 1) Scheduling hors-stage → phrases retirées (le hook / la question restent).
  if (!ctx.schedulingAllowed) dropSentence((s) => hasSchedulingLanguage(s));
  // 2) Sujets bannis reproposés → phrases retirées.
  for (const topic of ctx.forbidden.bannedTopics) {
    dropSentence((s) => containsTerm(s.toLowerCase(), topic));
  }
  // 3) Questions déjà posées (verbatim) → phrases retirées.
  for (const q of ctx.forbidden.questionsAsked) {
    const ql = q.toLowerCase();
    if (ql.trim()) dropSentence((s) => s.toLowerCase().includes(ql));
  }
  // 4) Placeholders [..] retirés.
  const noBracket = (s: string) => s.replace(/\s*\[[^\]\n]{1,40}\]\s*/g, " ");
  body = noBracket(body);
  if (subject) subject = noBracket(subject);
  // 5) Termes proscrits (dontSay) retirés (frontière de mot).
  for (const t of ctx.forbidden.dontSay) {
    const term = t.trim();
    if (!term) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, "giu");
    body = body.replace(re, "");
    if (subject) subject = subject.replace(re, "");
  }
  // 6) Registre casual : ouverture ado / argot / ponctuation excessive.
  if (ctx.voiceProfile.formality === "casual") {
    body = body.replace(/^\s*(?:yo|hey\s+yo|wesh|coucou)\b[\s,!?-]*/i, "");
    for (const slang of ["ouais", "grave", "chiant", "trop stylé"]) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(slang)}(?![\\p{L}\\p{N}])`, "giu");
      body = body.replace(re, "");
    }
    body = body.replace(/!{2,}/g, "!").replace(/\?{2,}/g, "?");
  } else {
    // 6b) Plancher de formalité : ouverture décontractée → salutation correcte
    //     dans la langue active (« Salut Alex » → « Bonjour Alex, » / « Hello Alex, »).
    body = body.replace(
      /^\s*(?:salut|coucou|hey|yo|wesh)\b[\s,!?-]*([\p{L}][\p{L}'-]*)?[\s,!?.-]*/iu,
      (_m, name?: string) => {
        const hi = fallbackLang(ctx.voiceProfile.language) === "fr" ? "Bonjour" : "Hello";
        return name ? `${hi} ${name}, ` : `${hi}, `;
      },
    );
  }
  // 7) Emoji interdit → retirés.
  if (ctx.voiceProfile.emojiUse === "none") body = stripEmojiChars(body);
  // 8) Nettoyage + longueur (troncature à la phrase).
  body = tidy(body);
  if (subject) subject = tidy(subject);
  if (body.length > ctx.bodyLimit) body = truncateToSentence(body, ctx.bodyLimit);

  return { channelHint: ctx.channelHint, subject: subject || undefined, body };
}
