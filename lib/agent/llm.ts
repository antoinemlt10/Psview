import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CAPS } from "./config";

// ── Client Anthropic — SERVEUR UNIQUEMENT ──
// La clé n'est lue que côté serveur. Ce module ne doit jamais être importé
// par un composant client. Le client est instancié paresseusement pour ne pas
// crasher au build si la clé est absente (elle est fournie au runtime Vercel).
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY manquante (côté serveur).");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// Convertit un schéma Zod en JSON Schema acceptable comme input_schema d'un tool.
// On retire $schema (mot-clé non nécessaire pour l'API) et on garantit type:"object".
function zodToInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json["$schema"];
  if (json["type"] !== "object") {
    return { type: "object", properties: {}, ...json } as Anthropic.Tool.InputSchema;
  }
  return json as Anthropic.Tool.InputSchema;
}

export interface StructuredCall<T> {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  timeoutMs: number;
}

export type StructuredResult<T> =
  | { ok: true; value: T; calls: number }
  | { ok: false; error: string; calls: number };

// Appel LLM structuré via tool-use forcé : on déclare UN tool dont l'input_schema
// est le schéma attendu, on force tool_choice, puis on valide la sortie avec Zod.
// Retry 1× (CAPS.schemaRetries) sur échec de parse/schéma. Timeout par appel.
// Ne throw jamais : renvoie { ok:false } en cas d'erreur.
export async function callStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const inputSchema = zodToInputSchema(call.schema);
  let calls = 0;
  let lastError = "unknown error";

  for (let attempt = 0; attempt <= CAPS.schemaRetries; attempt++) {
    calls++;
    try {
      const client = getClient();
      const userContent =
        attempt === 0
          ? call.user
          : `${call.user}\n\n[Note système : la sortie précédente était invalide vis-à-vis du schéma. Réponds STRICTEMENT en appelant le tool "${call.toolName}".]`;

      const res = await client.messages.create(
        {
          model: call.model,
          max_tokens: call.maxTokens,
          system: call.system,
          tools: [
            {
              name: call.toolName,
              description: call.toolDescription,
              input_schema: inputSchema,
            },
          ],
          tool_choice: { type: "tool", name: call.toolName },
          messages: [{ role: "user", content: userContent }],
        },
        { timeout: call.timeoutMs, maxRetries: 1 },
      );

      if (res.stop_reason === "refusal") {
        lastError = "refusal";
        continue;
      }

      const toolUse = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === call.toolName,
      );
      if (!toolUse) {
        lastError = "aucun bloc tool_use dans la réponse";
        continue;
      }

      const parsed = call.schema.safeParse(toolUse.input);
      if (!parsed.success) {
        lastError = "échec validation Zod: " + parsed.error.issues.map((i) => i.message).join("; ");
        continue;
      }
      return { ok: true, value: parsed.data, calls };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // timeout / réseau / etc. → on retente jusqu'à la limite puis fallback
    }
  }
  return { ok: false, error: lastError, calls };
}
