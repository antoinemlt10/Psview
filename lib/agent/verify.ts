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

// SCHEDULING — deux niveaux.
// CONCRET = logistique d'un rendez-vous (horaires, jours, créneaux, calendrier,
//   « let's book », « find a time »). Interdit hors propose_call/confirm_logistics.
// Affiné pour éviter les faux positifs : pas de « zoom »/« slot »/« 9h » nus
// (→ "slot machine", "9h/day"), et les jours de semaine ne matchent pas un nom de
// domaine (« Monday.com »). On garde les vrais signaux de logistique.
const CONCRETE_SCHEDULING_RE =
  /\b(?:cr[ée]neau|planifi|disponib|agenda|calend|calendly|cal\.com|book a|let'?s book|find a time|set up a (?:time|meeting|call)|pick a time|tomorrow|demain|next week|la semaine prochaine)\b|\b(?:monday|tuesday|wednesday|thursday|friday|lundi|mardi|mercredi|jeudi|vendredi)\b(?!\.)|\b\d{1,2}\s?(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i;
// SONDE D'INTÉRÊT = simple pont (« are you open to a short call? ») — autorisée partout.
const CALL_PROBE_RE =
  /\b(open to (?:a )?(?:short |quick |brief )?(?:call|chat)|up for (?:a )?(?:call|chat)|worth a (?:quick )?(?:call|chat)|ouvert[e]? à (?:un|une) (?:court[e]? )?(?:[ée]change|appel|discussion))\b/i;

export function hasConcreteScheduling(text: string): boolean {
  return CONCRETE_SCHEDULING_RE.test(text);
}
// Pour la journalisation des moves (PAS le gate) : logistique concrète OU sonde.
// (Plus de clause « call|meeting » nue : elle flaggait tout message mentionnant « call ».)
export function hasSchedulingLanguage(text: string): boolean {
  return CONCRETE_SCHEDULING_RE.test(text) || CALL_PROBE_RE.test(text);
}

// Normalise une langue (code ou nom) en "fr"/"en"/null (null = non vérifiable ici).
export function normalizeLang(l: string | undefined): "fr" | "en" | null {
  const s = (l ?? "").toLowerCase();
  if (/\b(fr|fra|fre|fran[cç]ais|french)\b/.test(s) || /^fr/.test(s)) return "fr";
  if (/\b(en|eng|anglais|english)\b/.test(s) || /^en/.test(s)) return "en";
  return null;
}

// Marqueurs forts par langue (mots-fonction + accents) pour détecter une FUITE
// de langue dans le message produit — y compris une salutation isolée.
// Mots-fonction français uniquement. On NE compte PAS les caractères accentués nus :
// l'anglais courant emploie des emprunts accentués (résumé, café, exposé, déjà vu) qui
// faisaient passer un message anglais pour français (faux positif → régénération inutile).
const FR_MARKERS =
  /\b(bonjour|bonsoir|salut|coucou|merci|cordialement|vous|votre|vos|nous|notre|nos|je|tu|avec|pour|dans|chez|[ée]quipe|poste|entreprise|ravi|ouvert|[ée]change|n'h[ée]sitez|c'est|nous sommes|au sujet)\b/gi;
const EN_MARKERS =
  /\b(hello|hi|hey|dear|thanks|thank you|regards|your|you|we|we're|our|the|with|for|role|team|company|reach|reaching|looking|open to|would you|happy to|about)\b/gi;
const FR_GREETING = /^\s*(bonjour|bonsoir|salut|coucou)\b/i;
const EN_GREETING = /^\s*(hi|hello|hey|dear|good\s+(morning|afternoon|evening))\b/i;

// GATE DE LANGUE déterministe : le message doit être ENTIÈREMENT dans outputLang.
// Détecte une langue ≠ cible (corps) ET une salutation d'une autre langue (cohérence
// intra-message : « Bonjour » en tête d'un message anglais = échec).
export function outputLanguageViolations(haystack: string, target: "fr" | "en" | null): string[] {
  if (!target) return [];
  const v: string[] = [];
  const frHits = (haystack.match(FR_MARKERS) ?? []).length;
  const enHits = (haystack.match(EN_MARKERS) ?? []).length;
  const firstLine = haystack.trim().split(/\n/)[0] ?? "";

  if (target === "en") {
    if (FR_GREETING.test(firstLine)) v.push("LANGUAGE: French greeting in an English message.");
    if (frHits >= 2) v.push(`LANGUAGE: French detected (${frHits} markers) — the message must be in English.`);
  } else {
    if (EN_GREETING.test(firstLine)) v.push("LANGUAGE: English greeting in a French message.");
    if (enHits >= 3) v.push(`LANGUAGE: English detected (${enHits} markers) — the message must be in French.`);
  }
  return v;
}

// Markdown interdit (canaux en texte brut). Détecte gras/italique, titres, puces,
// citations, code inline, liens markdown.
const MD_PATTERNS: RegExp[] = [
  /\*\*[^*]+\*\*/, // **gras**
  /__[^_]+__/, // __gras__
  /(?<![A-Za-z0-9])\*[^\s*][^*]*\*(?![A-Za-z0-9])/, // *italique*
  /^\s{0,3}#{1,6}\s+/m, // # titre
  /^\s*[-*+]\s+/m, // puce - * +
  /^\s*>\s+/m, // > citation
  /`[^`]+`/, // `code`
  /\[[^\]\n]+\]\([^)\n]+\)/, // [texte](lien)
];
export function hasMarkdown(text: string): boolean {
  return MD_PATTERNS.some((re) => re.test(text));
}
// Conversion déterministe markdown → texte brut (strip, structure préservée).
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1 ($2)") // liens
    .replace(/`([^`]+)`/g, "$1") // code inline
    .replace(/\*\*([^*]+)\*\*/g, "$1") // gras **
    .replace(/__([^_]+)__/g, "$1") // gras __
    .replace(/(?<![A-Za-z0-9])\*([^\s*][^*]*)\*(?![A-Za-z0-9])/g, "$1") // italique *
    .replace(/(?<![A-Za-z0-9])_([^\s_][^_]*)_(?![A-Za-z0-9])/g, "$1") // italique _
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // titres
    .replace(/^\s*>\s+/gm, "") // citations
    .replace(/^\s*[-*+]\s+/gm, "• ") // puces → bullet texte brut
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Salutation en tête + nom optionnel. Capte « Bonjour Alex, » / « Hi Sam » / « Hello, ».
const GREETING_OPENER =
  /^\s*(bonjour|bonsoir|salut|coucou|hello|hi|hey|dear)\b[\s,]*([\p{L}][\p{L}'-]*)?[\s,!.?-]*/iu;
// Mots qui suivent une salutation sans être un nom propre (à ne pas traiter en garbage).
const GENERIC_AFTER_GREETING = new Set(["there", "all", "team", "everyone", "folks", "again"]);
// Annonce explicite de non-présomption (à proscrire — la non-présomption est dans le TON).
const ANNOUNCED_NONPRESUMPTION =
  /\b(not assuming|without assuming|i won'?t assume|i'?m not assuming|no assumptions?|sans (?:rien )?pr[ée]sumer|je ne pr[ée]sume (?:rien|pas)|sans pr[ée]supposer)\b/i;

export interface DeterministicCtx {
  forbidden: ForbiddenList;
  voiceProfile: VoiceProfile;
  channelHint: ChannelHint;
  bodyLimit: number; // limite DURE de caractères (canal + hook/answer)
  schedulingAllowed: boolean; // logistique concrète d'appel autorisée ce tour ?
  outputLang: "fr" | "en" | null; // langue de sortie imposée (null = non vérifiable)
  allowGreeting: boolean; // salutation autorisée (= tout 1er message agent de la conv)
  candidateName?: string; // prénom réel du candidat (sinon : aucun nom)
  isIntro: boolean; // étape intro (contact froid)
}

// CHECKS DURS EN CODE — rapides, sans LLM. Renvoie la liste des violations.
export function deterministicChecks(msg: NextMessage, ctx: DeterministicCtx): string[] {
  const violations: string[] = [];
  const haystack = `${msg.subject ?? ""}\n${msg.body}`;
  const lower = haystack.toLowerCase();

  // 1) Termes proscrits (dontSay).
  for (const term of ctx.forbidden.dontSay) {
    if (containsTerm(lower, term)) violations.push(`Proscribed term present: "${term}".`);
  }

  // 2) Politique emoji.
  if (ctx.voiceProfile.emojiUse === "none" && hasEmoji(haystack)) {
    violations.push("Emoji present while policy is 'none'.");
  }

  // 3) Longueur cohérente avec le canal (limite DURE passée par l'orchestrateur).
  if (msg.body.length > ctx.bodyLimit) {
    violations.push(`Body too long (${msg.body.length} > ${ctx.bodyLimit} for ${ctx.channelHint}).`);
  }
  if (msg.body.trim().length === 0) violations.push("Empty body.");

  // 3b) Placeholders entre crochets interdits ([First Name], [Your Name], …).
  const bracket = haystack.match(/\[[^\]\n]{1,40}\]/);
  if (bracket) violations.push(`Bracketed placeholder forbidden: "${bracket[0]}".`);

  // 3c) Stage-gate du scheduling : logistique CONCRÈTE interdite hors call-stage.
  //     La SONDE d'intérêt (« open to a short call? ») reste autorisée (pont).
  if (!ctx.schedulingAllowed && hasConcreteScheduling(haystack)) {
    violations.push("Concrete call logistics out-of-stage (time/day/slot not allowed this turn).");
  }

  // 3f) Salutation : seulement au tout 1er message agent ; jamais de nom inexistant.
  const g = msg.body.match(GREETING_OPENER);
  if (g) {
    const name = g[2];
    if (!ctx.allowGreeting) {
      violations.push("Greeting although this is not the first message (no re-greeting).");
    } else if (name && !GENERIC_AFTER_GREETING.has(name.toLowerCase())) {
      if (!ctx.candidateName) {
        violations.push(`Name in greeting although candidate is unknown: "${name}".`);
      } else if (name.toLowerCase() !== ctx.candidateName.toLowerCase()) {
        violations.push(`Incorrect greeting name: "${name}" (expected "${ctx.candidateName}").`);
      }
    }
  }

  // 3g) Non-présomption ANNONCÉE (doit être dans le ton, pas déclarée).
  if (ctx.isIntro && ANNOUNCED_NONPRESUMPTION.test(haystack)) {
    violations.push("Non-presumption announced explicitly (must stay in the tone).");
  }

  // 3d) Gate de langue : message entièrement dans outputLang (corps + salutation).
  violations.push(...outputLanguageViolations(haystack, ctx.outputLang));

  // 3e) Markdown interdit (canaux texte brut).
  if (hasMarkdown(haystack)) violations.push("Markdown present (plain-text channel).");

  // 4) Mémoire : reproposition d'un sujet banni (rejet/écarté actif).
  for (const topic of ctx.forbidden.bannedTopics) {
    if (containsTerm(lower, topic)) violations.push(`Re-proposes a banned topic: "${topic}".`);
  }

  // 5) Anti-répétition : question déjà posée re-posée verbatim.
  //    (pointsMade = directives de planification abstraites : non vérifiables par substring
  //     — laissées au writer comme garde-fou + au VERIFY LLM sémantique.)
  for (const q of ctx.forbidden.questionsAsked) {
    if (q && lower.includes(q.toLowerCase())) {
      violations.push(`Re-asks an already-asked question: "${q}".`);
    }
  }

  // 6) Registre casual = chaleureux mais PROPRE (jamais ado/texto).
  if (ctx.voiceProfile.formality === "casual") {
    const opening = msg.body.trimStart();
    if (/^(yo\b|hey\s+yo\b|wesh\b|coucou\b)/i.test(opening)) {
      violations.push("Opening too familiar/teen in casual (Yo/Hey yo/Wesh/Coucou).");
    }
    for (const slang of ["ouais", "grave", "chiant", "trop stylé"]) {
      if (containsTerm(lower, slang)) violations.push(`Proscribed slang in casual: "${slang}".`);
    }
    if (haystack.includes("!!!") || haystack.includes("???")) {
      violations.push("Excessive punctuation (!!! / ???) — not in clean casual.");
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

export interface LlmVerifyOpts {
  adherence?: AdherenceCtx;
  language?: string; // langue de sortie attendue (proofread grammaire/native)
}

// VERIFY LLM (modèle léger) — vérifications sémantiques que le code rate :
//  (A) MÉMOIRE : reproposition proche d'un rejet, re-demande d'une info connue, redite ;
//  (B) ADHÉRENCE : le message FINAL a-t-il exécuté la décision (mustDo) et évité les mustNotDo ;
//  (C) COHÉRENCE : pas de référent implicite / phrase sur-compressée ;
//  (D) GRAMMAIRE : prose native et irréprochable dans la langue de sortie (anti-calque).
// (C) et (D) s'appliquent à TOUS les messages, y compris l'opener (1er message).
export async function llmVerify(
  msg: NextMessage,
  forbidden: ForbiddenList,
  opts: LlmVerifyOpts = {},
): Promise<LlmVerifyResult> {
  const adherence = opts.adherence;
  // (C) cohérence + (D) grammaire sont toujours pertinentes → on appelle toujours.

  const system = [
    "You are a strict verifier of a recruiting agent's FINAL message. Reply via the tool;",
    "write every violation string in English.",
    "(A) MEMORY: detect any re-proposal (even loosely) of a banned topic, re-asking an",
    "already-known fact, re-raising a dismissed topic, or repeating an argument already made.",
    "(B) ADHERENCE: does the message execute EVERY mustDo item? Does it avoid ALL mustNotDo",
    "and every listed repetition? A divergence (missing mustDo, or a mustNotDo present, e.g.",
    "re-describes the role, apologizes again, pushes a call) = violation.",
    "(C) COHERENCE / CLARITY (a floor concision never violates): each sentence must be",
    'self-sufficient. Flag any IMPLICIT pronoun/subject with no stated referent (e.g. "It\'s built',
    'in." without saying of WHAT; "Not a stretch, not occasional." with no subject), any',
    "over-compressed sentence unintelligible out of context, any reference to something unstated.",
    opts.language
      ? `(D) GRAMMAR / NATIVE LANGUAGE: the prose must be flawless and NATIVE in ${opts.language}. ` +
        'Flag any calque from another language: missing article ("plupart des…" instead of ' +
        '"la plupart des…"), wrong agreement/conjugation, non-native word order, translated phrasing. = violation.'
      : "",
    "If everything is fine: pass=true. Otherwise pass=false + precise violations.",
  ]
    .filter(Boolean)
    .join(" ");

  const user = [
    "FINAL MESSAGE:",
    `subject: ${msg.subject ?? "(none)"}`,
    `body: ${msg.body}`,
    "",
    "MEMORY FORBIDDEN:",
    `banned topics: ${JSON.stringify(forbidden.bannedTopics)}`,
    `known facts (do not re-ask): ${JSON.stringify(forbidden.knownFacts)}`,
    `arguments already made: ${JSON.stringify(forbidden.pointsMade)}`,
    `questions already asked: ${JSON.stringify(forbidden.questionsAsked)}`,
    ...(adherence
      ? [
          "",
          "DECISION TO HAVE EXECUTED:",
          adherence.decision,
          `MUST DO: ${JSON.stringify(adherence.mustDo)}`,
          `MUST NOT DO: ${JSON.stringify(adherence.mustNotDo)}`,
          `REPETITIONS TO AVOID: ${JSON.stringify(adherence.avoidedRepetition)}`,
        ]
      : []),
  ].join("\n");

  const res = await callStructured({
    model: MODELS.verify,
    system,
    user,
    toolName: "verdict",
    toolDescription: "Rend un verdict pass/violations sur mémoire, adhérence, cohérence et grammaire.",
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

  // 0) Markdown → texte brut (strip déterministe, structure préservée).
  if (hasMarkdown(body)) body = stripMarkdown(body);
  if (subject && hasMarkdown(subject)) subject = stripMarkdown(subject);

  const dropSentence = (pred: (s: string) => boolean) => {
    body = splitSentences(body)
      .filter((s) => s.trim() && !pred(s))
      .join(" ");
  };

  // 1) Logistique d'appel CONCRÈTE hors-stage → phrases retirées. La SONDE d'intérêt
  //    (« open to a short call? ») est conservée (sauf si elle porte aussi du concret).
  if (!ctx.schedulingAllowed) {
    dropSentence((s) => hasConcreteScheduling(s) && !CALL_PROBE_RE.test(s));
    // Si une phrase mêle sonde + concret, on retire juste le concret en gardant la sonde.
    body = splitSentences(body)
      .map((s) => (hasConcreteScheduling(s) ? s.replace(CONCRETE_SCHEDULING_RE, "").replace(/\s{2,}/g, " ") : s))
      .join(" ");
  }
  // 1b) Non-présomption annoncée (intro) → phrase retirée.
  if (ctx.isIntro) dropSentence((s) => ANNOUNCED_NONPRESUMPTION.test(s));
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
  // 6c) Langue : salutation dans la mauvaise langue → réécrite dans outputLang
  //     (dernier recours pour le cas « Bonjour » en tête d'un message anglais ;
  //     un corps entier mal-langue est traité par régénération en amont).
  if (ctx.outputLang === "en" && FR_GREETING.test(body)) {
    body = body.replace(/^\s*(?:bonjour|bonsoir|salut|coucou)\b[\s,!?-]*([\p{L}][\p{L}'-]*)?[\s,!?.-]*/iu, (_m, name?: string) =>
      name ? `Hello ${name}, ` : "Hello, ",
    );
  } else if (ctx.outputLang === "fr" && EN_GREETING.test(body)) {
    body = body.replace(/^\s*(?:hi|hello|hey|dear)\b[\s,!?-]*([\p{L}][\p{L}'-]*)?[\s,!?.-]*/iu, (_m, name?: string) =>
      name ? `Bonjour ${name}, ` : "Bonjour, ",
    );
  }
  // 6d) Politique de salutation : pas de greeting après le 1er message ; pas de nom
  //     inexistant/incorrect (candidat inconnu → aucun nom).
  const gm = body.match(GREETING_OPENER);
  if (gm) {
    if (!ctx.allowGreeting) {
      // Re-greeting → on retire la salutation, on garde le reste du message.
      body = body.slice(gm[0].length).trimStart();
      body = body.charAt(0).toUpperCase() + body.slice(1);
    } else {
      const name = gm[2];
      const generic = name && GENERIC_AFTER_GREETING.has(name.toLowerCase());
      if (name && !generic) {
        const hi = gm[1];
        if (!ctx.candidateName) {
          body = `${hi}, ` + body.slice(gm[0].length).trimStart();
        } else if (name.toLowerCase() !== ctx.candidateName.toLowerCase()) {
          body = `${hi} ${ctx.candidateName}, ` + body.slice(gm[0].length).trimStart();
        }
      }
    }
  }
  // 7) Emoji interdit → retirés.
  if (ctx.voiceProfile.emojiUse === "none") body = stripEmojiChars(body);
  // 8) Nettoyage + longueur (troncature à la phrase).
  body = tidy(body);
  if (subject) subject = tidy(subject);
  if (body.length > ctx.bodyLimit) body = truncateToSentence(body, ctx.bodyLimit);

  return { channelHint: ctx.channelHint, subject: subject || undefined, body };
}
