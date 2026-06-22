import { NextResponse } from "next/server";
import type { AgentInput } from "@/lib/agent/types";
import { runAgent } from "@/lib/agent/runAgent";

// ─────────────────────────────────────────────────────────────────────────────
// THE INTEGRATION SEAM — now wired to the REAL reasoning engine (lib/agent/*).
// Stateless endpoint: receives an AgentInput, returns an AgentOutput. The rich
// engine state round-trips via AgentOutput.state ↔ AgentInput.priorState, stored
// client-side. The ANTHROPIC_API_KEY is read server-side only (see .env.example).
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: Request) {
  let body: AgentInput;
  try {
    body = (await req.json()) as AgentInput;
  } catch {
    return badRequest("Body must be valid JSON.");
  }

  // Contract validation — the one field everything else hangs off.
  if (!body?.companyContext?.identity?.name?.trim()) {
    return badRequest("companyContext.identity.name is required.");
  }
  if (!Array.isArray(body.conversation)) {
    body.conversation = [];
  }
  if (typeof body.intent !== "string") {
    body.intent = "";
  }

  // runAgent ne throw jamais : meta.ok=false en cas d'erreur interne (la trace
  // côté UI restera utilisable, avec un message de repli ancré).
  const output = await runAgent(body);
  return NextResponse.json(output);
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    note: "POST an AgentInput here. Wired to the real reasoning engine (lib/agent/runAgent).",
  });
}
