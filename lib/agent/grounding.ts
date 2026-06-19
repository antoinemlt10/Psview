import type { CandidateMemory, CompanyContext, AgentMemory } from "./types";
import { enforcedEntries } from "./memory";

// Résout un chemin "identity.name" / "hiring.roles[0].title" / "culture.values"
// dans le contexte. Renvoie undefined si introuvable.
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function stringifyValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export interface GroundingPack {
  // Champs exacts à citer, sous forme lisible "chemin = valeur".
  fields: { path: string; value: string }[];
  // Liste plate pour la trace (groundingUsed).
  used: string[];
}

// Assemble le PACK D'ANCRAGE depuis les groundingFields demandés par REASON :
// uniquement des VALEURS EXACTES du contexte, jamais le contexte brut entier.
export function buildGroundingPack(ctx: CompanyContext, groundingFields: string[]): GroundingPack {
  const fields: { path: string; value: string }[] = [];
  const used: string[] = [];
  const seen = new Set<string>();

  for (const path of groundingFields) {
    if (seen.has(path)) continue;
    const v = getByPath(ctx, path);
    if (v === undefined || v === null || v === "") continue;
    const value = stringifyValue(v);
    fields.push({ path, value });
    used.push(`${path} = ${value}`);
    seen.add(path);
  }

  // Filet de sécurité : toujours fournir au moins le nom + le one-liner.
  if (fields.length === 0) {
    fields.push({ path: "identity.name", value: ctx.identity.name });
    fields.push({ path: "identity.oneLiner", value: ctx.identity.oneLiner });
    used.push(`identity.name = ${ctx.identity.name}`, `identity.oneLiner = ${ctx.identity.oneLiner}`);
  }
  return { fields, used };
}

export interface ForbiddenList {
  bannedTopics: string[]; // rejets + sujets écartés actifs → ne JAMAIS reproposer
  constraints: string[]; // contraintes actives → respecter
  knownFacts: string[]; // infos connues → ne pas re-demander
  pointsMade: string[]; // arguments déjà servis → ne pas répéter
  questionsAsked: string[]; // questions déjà posées → ne pas re-poser
  proposalsMade: string[]; // propositions déjà faites
  dontSay: string[]; // termes interdits par la voix
  conditional: string[]; // réversions molles : autorisé SI condition
}

// Prépare pour le writer la LISTE D'INTERDITS explicite (défense en profondeur).
export function buildForbiddenList(
  ctx: CompanyContext,
  mem: CandidateMemory,
  agentMem: AgentMemory,
): ForbiddenList {
  const bannedTopics = [
    ...mem.rejections.filter((e) => e.status === "active").map((e) => e.content),
    ...mem.dismissedTopics.filter((e) => e.status === "active").map((e) => e.content),
  ];
  const conditional = [
    ...enforcedEntries(mem, "rejections"),
    ...enforcedEntries(mem, "constraints"),
    ...enforcedEntries(mem, "dismissedTopics"),
  ]
    .filter((e) => e.status === "softened")
    .map((e) => `« ${e.content} »${e.condition ? ` autorisé SI : ${e.condition}` : " (assoupli)"}`);

  return {
    bannedTopics,
    constraints: mem.constraints.filter((e) => e.status === "active").map((e) => e.content),
    knownFacts: enforcedEntries(mem, "facts").map((e) => e.content),
    pointsMade: agentMem.pointsMade,
    questionsAsked: agentMem.questionsAsked,
    proposalsMade: agentMem.proposalsMade,
    dontSay: ctx.voice.dontSay ?? [],
    conditional,
  };
}

export function renderForbiddenList(f: ForbiddenList): string {
  const block = (label: string, items: string[]) =>
    items.length ? `${label}:\n${items.map((i) => `  - ${i}`).join("\n")}` : "";
  return [
    block("INTERDIT — sujets bannis (rejets / écartés actifs, ne JAMAIS reproposer)", f.bannedTopics),
    block("INTERDIT — termes proscrits (dontSay)", f.dontSay),
    block("NE PAS re-demander — infos déjà connues", f.knownFacts),
    block("NE PAS répéter — arguments déjà servis", f.pointsMade),
    block("NE PAS re-poser — questions déjà posées", f.questionsAsked),
    block("DÉJÀ proposé", f.proposalsMade),
    block("À RESPECTER — contraintes actives", f.constraints),
    block("CONDITIONNEL — autorisé seulement si la condition est remplie", f.conditional),
  ]
    .filter(Boolean)
    .join("\n");
}
