/**
 * Eval OPENER-QUALITY : génère un opener (1er message, conversation vide) sur ~15
 * contextes variés (FR/EN, formal/casual, secteurs différents) et asserte sur chacun :
 *   (1) langue correcte partout (corps + salutation),
 *   (2) zéro markdown / placeholder / nom garbage,
 *   (3) ne commence pas par du boilerplate de description d'entreprise,
 *   (4) longueur ≤ limite du canal (hook).
 * Sort un pass/fail par contexte + un score global.
 *
 *   npm run eval:opener
 * Nécessite ANTHROPIC_API_KEY (appels LLM réels).
 */
import type { AgentInput, CompanyContext, Formality, EmojiUse } from "../lib/agent/types";
import { runAgent } from "../lib/agent/runAgent";
import { channelLimit } from "../lib/agent/config";
import {
  hasMarkdown,
  outputLanguageViolations,
  openerBoilerplateViolations,
  frenchCalqueViolations,
} from "../lib/agent/verify";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env déjà présent (CI) */
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY manquante — impossible de lancer l'eval opener.");
  process.exit(1);
}

type Lang = "fr" | "en";
interface Case {
  label: string;
  lang: Lang;
  formality: Formality;
  emoji: EmojiUse;
  ctx: CompanyContext;
}

function ctxOf(o: {
  name: string;
  oneLiner: string;
  industry: string;
  size: string;
  roleTitle: string;
  skills: string[];
  tone: string;
  formality: Formality;
  language: Lang;
  emoji: EmojiUse;
  values: string[];
  dontSay?: string[];
}): CompanyContext {
  return {
    identity: { name: o.name, oneLiner: o.oneLiner, industry: o.industry, sizeStage: o.size },
    culture: { values: o.values, cultureNotes: "" },
    hiring: {
      roles: [{ title: o.roleTitle, seniority: "senior", whatTheyllDo: o.oneLiner, mustHaveSkills: o.skills }],
      idealCandidateTraits: [],
    },
    voice: { tone: o.tone, formality: o.formality, language: o.language, emojiUse: o.emoji, dontSay: o.dontSay ?? [] },
  };
}

const CASES: Case[] = [
  { label: "space/EN/formal", lang: "en", formality: "formal", emoji: "none",
    ctx: ctxOf({ name: "Heliogen Labs", oneLiner: "real-time MHD plasma simulation for fusion", industry: "deep tech / fusion", size: "Series A (Boston)", roleTitle: "Senior Simulation Engineer", skills: ["C++", "numerical computing"], tone: "serious, precise", formality: "formal", language: "en", emoji: "none", values: ["rigor"] }) },
  { label: "fintech/EN/neutral", lang: "en", formality: "neutral", emoji: "sparing",
    ctx: ctxOf({ name: "Ledgerly", oneLiner: "instant reconciliation for finance teams", industry: "fintech", size: "seed (NYC)", roleTitle: "Founding Backend Engineer", skills: ["Go", "Postgres"], tone: "warm and direct", formality: "neutral", language: "en", emoji: "sparing", values: ["Ownership"], dontSay: ["rockstar", "ninja"] }) },
  { label: "gaming/EN/casual", lang: "en", formality: "casual", emoji: "liberal",
    ctx: ctxOf({ name: "Pixelforge", oneLiner: "co-op roguelikes with emergent physics", industry: "games", size: "indie studio (Austin)", roleTitle: "Gameplay Engineer", skills: ["Unity", "C#"], tone: "playful, energetic", formality: "casual", language: "en", emoji: "liberal", values: ["Craft"] }) },
  { label: "biotech/EN/formal", lang: "en", formality: "formal", emoji: "none",
    ctx: ctxOf({ name: "Helixa Bio", oneLiner: "protein design with generative models", industry: "biotech", size: "Series B (SF)", roleTitle: "ML Research Scientist", skills: ["PyTorch", "structural biology"], tone: "rigorous, understated", formality: "formal", language: "en", emoji: "none", values: ["Evidence"] }) },
  { label: "logistics/EN/neutral", lang: "en", formality: "neutral", emoji: "none",
    ctx: ctxOf({ name: "Routewise", oneLiner: "live routing for last-mile fleets", industry: "logistics", size: "Series A (Chicago)", roleTitle: "Staff Engineer", skills: ["Kafka", "optimization"], tone: "pragmatic", formality: "neutral", language: "en", emoji: "none", values: ["Reliability"] }) },
  { label: "cybersec/EN/neutral", lang: "en", formality: "neutral", emoji: "none",
    ctx: ctxOf({ name: "Bastion", oneLiner: "runtime detection for cloud workloads", industry: "cybersecurity", size: "Series A (Seattle)", roleTitle: "Detection Engineer", skills: ["eBPF", "Rust"], tone: "sharp, candid", formality: "neutral", language: "en", emoji: "none", values: ["Candor"] }) },
  { label: "edtech/EN/casual", lang: "en", formality: "casual", emoji: "sparing",
    ctx: ctxOf({ name: "Lumi Learn", oneLiner: "1:1 AI tutoring that adapts per student", industry: "edtech", size: "seed (Remote)", roleTitle: "Full-Stack Engineer", skills: ["TypeScript", "Next.js"], tone: "friendly, encouraging", formality: "casual", language: "en", emoji: "sparing", values: ["Impact"] }) },
  { label: "music/EN/casual", lang: "en", formality: "casual", emoji: "liberal",
    ctx: ctxOf({ name: "Tempo", oneLiner: "collaborative DAW in the browser", industry: "music tech", size: "seed (LA)", roleTitle: "Audio Engineer", skills: ["WebAudio", "DSP"], tone: "creative, warm", formality: "casual", language: "en", emoji: "liberal", values: ["Craft"] }) },
  { label: "fintech/FR/formal", lang: "fr", formality: "formal", emoji: "none",
    ctx: ctxOf({ name: "Sequoia Finance", oneLiner: "la conformité réglementaire automatisée pour les banques", industry: "fintech", size: "série B (Paris)", roleTitle: "Ingénieur Backend Senior", skills: ["Java", "Kafka"], tone: "sérieux, précis", formality: "formal", language: "fr", emoji: "none", values: ["Rigueur"] }) },
  { label: "fashion/FR/neutral", lang: "fr", formality: "neutral", emoji: "sparing",
    ctx: ctxOf({ name: "Maille", oneLiner: "la mode circulaire à partir de fibres recyclées", industry: "mode / retail", size: "amorçage (Lyon)", roleTitle: "Lead Produit", skills: ["product", "growth"], tone: "chaleureux, direct", formality: "neutral", language: "fr", emoji: "sparing", values: ["Durabilité"] }) },
  { label: "agtech/FR/neutral", lang: "fr", formality: "neutral", emoji: "none",
    ctx: ctxOf({ name: "Terraviva", oneLiner: "le pilotage agronomique par capteurs et satellite", industry: "agtech", size: "série A (Toulouse)", roleTitle: "Data Engineer", skills: ["Python", "géospatial"], tone: "pragmatique", formality: "neutral", language: "fr", emoji: "none", values: ["Terrain"] }) },
  { label: "health/FR/formal", lang: "fr", formality: "formal", emoji: "none",
    ctx: ctxOf({ name: "Soignia", oneLiner: "la coordination des soins pour les hôpitaux", industry: "santé", size: "série A (Lille)", roleTitle: "Ingénieure Logiciel Senior", skills: ["Elixir", "FHIR"], tone: "rassurant, rigoureux", formality: "formal", language: "fr", emoji: "none", values: ["Soin"] }) },
  { label: "gaming/FR/casual", lang: "fr", formality: "casual", emoji: "liberal",
    ctx: ctxOf({ name: "Bastogne Games", oneLiner: "des party games mobiles à jouer en local", industry: "jeux vidéo", size: "studio indé (Bordeaux)", roleTitle: "Développeur Gameplay", skills: ["Unity", "C#"], tone: "fun, énergique", formality: "casual", language: "fr", emoji: "liberal", values: ["Plaisir"] }) },
  { label: "legal/FR/formal", lang: "fr", formality: "formal", emoji: "none",
    ctx: ctxOf({ name: "Clausa", oneLiner: "l'analyse contractuelle assistée par IA pour les cabinets", industry: "legal tech", size: "amorçage (Paris)", roleTitle: "Ingénieur NLP", skills: ["NLP", "Python"], tone: "précis, sobre", formality: "formal", language: "fr", emoji: "none", values: ["Précision"] }) },
  { label: "food/FR/casual", lang: "fr", formality: "casual", emoji: "sparing",
    ctx: ctxOf({ name: "Cassoulet", oneLiner: "les circuits courts livrés en moins de 24h", industry: "food tech", size: "amorçage (Marseille)", roleTitle: "Ingénieur Full-Stack", skills: ["TypeScript", "Next.js"], tone: "convivial, direct", formality: "casual", language: "fr", emoji: "sparing", values: ["Goût"] }) },
];

const GREETING_NAME_RE =
  /^\s*(hi|hello|hey|dear|bonjour|bonsoir|salut|coucou)\b[\s,]+([A-Z][\p{L}'-]+)/u;
const GENERIC = new Set(["there", "all", "team", "everyone", "folks", "again"]);

function check(body: string, channelHint: "email" | "linkedin" | "sms", lang: Lang) {
  const fails: string[] = [];
  // (1) langue
  const langV = outputLanguageViolations(`\n${body}`, lang);
  if (langV.length) fails.push(`lang(${langV.length})`);
  // (2) markdown / placeholder / nom garbage (candidat inconnu → aucun prénom attendu)
  if (hasMarkdown(body)) fails.push("markdown");
  if (/\[[^\]\n]{1,40}\]/.test(body)) fails.push("placeholder");
  const gm = body.match(GREETING_NAME_RE);
  if (gm && !GENERIC.has(gm[2].toLowerCase())) fails.push(`garbage-name(${gm[2]})`);
  // (3) boilerplate
  if (openerBoilerplateViolations(body).length) fails.push("boilerplate");
  // (3b) calque FR « plupart » sans article (proofread grammatical)
  if (lang === "fr" && frenchCalqueViolations(body).length) fails.push("calque-plupart");
  // (4) longueur ≤ limite canal (hook)
  const limit = channelLimit(channelHint, true);
  if (body.length > limit) fails.push(`length(${body.length}>${limit})`);
  return fails;
}

async function main() {
  console.log("Eval OPENER-QUALITY — génération d'openers sur", CASES.length, "contextes (appels LLM réels)…\n");
  let pass = 0;
  const rows: string[] = [];
  for (const c of CASES) {
    const input: AgentInput = { companyContext: c.ctx, intent: "engage this candidate and book a call", conversation: [] };
    let body = "";
    let channelHint: "email" | "linkedin" | "sms" = "email";
    let fails: string[];
    try {
      const out = await runAgent(input);
      const m = out.nextMessages[0];
      body = m?.body ?? "";
      channelHint = (m?.channelHint ?? "email") as "email" | "linkedin" | "sms";
      fails = body.trim() ? check(body, channelHint, c.lang) : ["empty"];
      if (out.meta && !out.meta.ok) fails.push(`meta:${out.meta.errors[0] ?? "not-ok"}`);
    } catch (e) {
      fails = [`threw:${e instanceof Error ? e.message : String(e)}`];
    }
    const okCase = fails.length === 0;
    if (okCase) pass++;
    rows.push(
      `${okCase ? "PASS" : "FAIL"}  ${c.label.padEnd(20)} ${okCase ? "" : "→ " + fails.join(", ")}\n        « ${body.slice(0, 96).replace(/\n/g, " ")}${body.length > 96 ? "…" : ""} »`,
    );
  }
  console.log("──────── RÉCAP OPENER-QUALITY ────────");
  for (const r of rows) console.log(r);
  console.log("──────────────────────────────────────");
  console.log(`${pass}/${CASES.length} OK, ${CASES.length - pass} échec(s).`);
  process.exit(pass === CASES.length ? 0 : 1);
}

void main();
