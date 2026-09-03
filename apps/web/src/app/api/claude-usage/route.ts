import { NextResponse } from "next/server";
import type { ClaudeUsageData } from "@hermes/shared";
import { resolveAgentUrl } from "@/lib/agentUrl.server";

/**
 * Proxy fino al agente: el escaneo real de ~/.claude/projects/*.jsonl vive en
 * apps/agent/src/claude-usage.ts (GET /claude/usage), porque este route
 * handler puede correr en Vercel, sin ese disco. Aquí solo se reenvía.
 *
 * Base URL resuelta por `resolveAgentUrl()` (remote_config, con
 * NEXT_PUBLIC_HERMES_URL de respaldo) — ver el comentario de ese archivo:
 * el quick tunnel del agente rota de URL en cada reinicio.
 */
function authHeaders(): Record<string, string> {
  const key = process.env.HERMES_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Lee ~/.claude en cada request (uso en vivo); nunca se pre-renderiza.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const hermesUrl = await resolveAgentUrl();
    const res = await fetch(`${hermesUrl}/claude/usage`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`agente → ${res.status}`);
    const data = (await res.json()) as ClaudeUsageData;
    return NextResponse.json(data);
  } catch (error) {
    console.error("Fallo al leer el uso de Claude (agente):", error);
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
