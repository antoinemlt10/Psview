import { z } from "zod";
import type {
  AgentMemory,
  CandidateMemory,
  MemoryBucket,
  MemoryEntry,
  MemoryOp,
} from "./types";

export const MEMORY_BUCKETS: MemoryBucket[] = [
  "rejections",
  "constraints",
  "objections",
  "facts",
  "dismissedTopics",
  "styleFeedback",
];

// ── Schéma Zod des MemoryOp (émises par REASON, validées avant application) ──
export const MemoryOpSchema: z.ZodType<MemoryOp> = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    bucket: z.enum([
      "rejections",
      "constraints",
      "objections",
      "facts",
      "dismissedTopics",
      "styleFeedback",
    ]),
    content: z.string(),
    strength: z.number().min(0).max(1).optional(),
    condition: z.string().optional(),
  }),
  z.object({ op: z.literal("retract"), targetId: z.string() }),
  z.object({
    op: z.literal("soften"),
    targetId: z.string(),
    condition: z.string().optional(),
    strength: z.number().min(0).max(1).optional(),
  }),
  z.object({ op: z.literal("resolve"), targetId: z.string() }),
  z.object({ op: z.literal("supersede"), targetId: z.string(), content: z.string() }),
]) as unknown as z.ZodType<MemoryOp>;

export function emptyCandidateMemory(): CandidateMemory {
  return {
    rejections: [],
    constraints: [],
    objections: [],
    facts: [],
    dismissedTopics: [],
    styleFeedback: [],
    temperature: "cold",
  };
}

export function emptyAgentMemory(): AgentMemory {
  return { pointsMade: [], questionsAsked: [], proposalsMade: [] };
}

function findEntry(
  mem: CandidateMemory,
  id: string,
): { bucket: MemoryBucket; entry: MemoryEntry } | null {
  for (const bucket of MEMORY_BUCKETS) {
    const entry = mem[bucket].find((e) => e.id === id);
    if (entry) return { bucket, entry };
  }
  return null;
}

export interface ApplyResult {
  memory: CandidateMemory;
  summary: string[];
  objectionsRaised: number;
  objectionsResolved: number;
}

// Applique les MemoryOp. RÈGLE DURE : on ne supprime JAMAIS — on change le status
// et on garde la trace (anti-whipsaw, démo, poids recency vs strength).
export function applyMemoryOps(
  prev: CandidateMemory,
  ops: MemoryOp[],
  turn: number,
): ApplyResult {
  const memory: CandidateMemory = structuredClone(prev);
  const summary: string[] = [];
  let objectionsRaised = 0;
  let objectionsResolved = 0;
  let seq = 0;

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const entry: MemoryEntry = {
          id: `${op.bucket.slice(0, 3)}_t${turn}_${seq++}`,
          content: op.content,
          turn,
          status: "active",
          strength: op.strength ?? 1,
          ...(op.condition ? { condition: op.condition } : {}),
        };
        memory[op.bucket].push(entry);
        if (op.bucket === "objections") objectionsRaised++;
        summary.push(`+ ${op.bucket}: "${op.content}"`);
        break;
      }
      case "retract": {
        const hit = findEntry(memory, op.targetId);
        if (hit) {
          hit.entry.status = "retracted";
          hit.entry.cause = "candidate_reversed";
          hit.entry.resolvedTurn = turn;
          summary.push(`↩ retract (${hit.bucket}): "${hit.entry.content}" — candidate reversed`);
        }
        break;
      }
      case "soften": {
        const hit = findEntry(memory, op.targetId);
        if (hit) {
          hit.entry.status = "softened";
          if (op.condition) hit.entry.condition = op.condition;
          hit.entry.strength = op.strength ?? Math.min(hit.entry.strength ?? 1, 0.5);
          summary.push(
            `~ soften (${hit.bucket}): "${hit.entry.content}"${
              hit.entry.condition ? ` if: ${hit.entry.condition}` : ""
            }`,
          );
        }
        break;
      }
      case "resolve": {
        const hit = findEntry(memory, op.targetId);
        if (hit) {
          hit.entry.status = "resolved";
          hit.entry.cause = "agent_persuaded";
          hit.entry.resolvedTurn = turn;
          if (hit.bucket === "objections") objectionsResolved++;
          summary.push(`✓ resolve (${hit.bucket}): "${hit.entry.content}" — addressed by agent`);
        }
        break;
      }
      case "supersede": {
        const hit = findEntry(memory, op.targetId);
        if (hit) {
          hit.entry.status = "superseded";
          hit.entry.resolvedTurn = turn;
          const entry: MemoryEntry = {
            id: `${hit.bucket.slice(0, 3)}_t${turn}_${seq++}`,
            content: op.content,
            turn,
            status: "active",
            strength: 1,
          };
          memory[hit.bucket].push(entry);
          summary.push(`⇄ supersede (${hit.bucket}): "${hit.entry.content}" → "${op.content}"`);
        }
        break;
      }
    }
  }

  return { memory, summary, objectionsRaised, objectionsResolved };
}

// L'enforcement n'agit que sur les entrées "active" (et "softened" avec sa condition).
// resolved / retracted / superseded NE CONTRAIGNENT PLUS.
export function isEnforced(e: MemoryEntry): boolean {
  return e.status === "active" || e.status === "softened";
}

export function enforcedEntries(mem: CandidateMemory, bucket: MemoryBucket): MemoryEntry[] {
  return mem[bucket].filter(isEnforced);
}

// styleAdjustments dérivés du styleFeedback ACTIF → se superposent au persona de base.
export function deriveStyleAdjustments(mem: CandidateMemory): string[] {
  return enforcedEntries(mem, "styleFeedback").map((e) => e.content);
}

// Met à jour la température (déterministe) à partir de la mémoire + du dernier message.
export function updateTemperature(
  mem: CandidateMemory,
  incomingReply: string | undefined,
): CandidateMemory["temperature"] {
  let score = 0;
  score += enforcedEntries(mem, "facts").length; // engagement : partage d'infos
  score -= 1.5 * enforcedEntries(mem, "rejections").length;
  score -= 1 * enforcedEntries(mem, "objections").length;
  score += 1.5 * mem.objections.filter((e) => e.status === "resolved").length;

  const text = (incomingReply ?? "").toLowerCase();
  const positive = [
    "intéress",
    "curieu",
    "ok pour",
    "d'accord",
    "parlons",
    "dispo",
    "volontiers",
    "interested",
    "let's talk",
    "sounds good",
    "sure",
  ];
  const negative = [
    "pas intéress",
    "non merci",
    "bien là où",
    "happy where",
    "not interested",
    "no thanks",
    "stop",
    "leave me",
  ];
  if (positive.some((p) => text.includes(p))) score += 2;
  if (negative.some((n) => text.includes(n))) score -= 2;

  if (score <= -2) return "cold";
  if (score <= 0) return "lukewarm";
  if (score <= 2) return "warm";
  return "hot";
}
