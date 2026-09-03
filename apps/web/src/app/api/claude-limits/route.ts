import { NextResponse } from "next/server";
import type { ClaudeLimits } from "@hermes/shared";
import { resolveAgentUrl } from "@/lib/agentUrl.server";

/**
 * Proxy fino al agente: la lectura real de ~/.claude/* vive en
 * apps/agent/src/claude-limits.ts (GET /claude/limits), porque este route
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

// Consulta en vivo los límites del plan; nunca se pre-renderiza.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const hermesUrl = await resolveAgentUrl();
    const res = await fetch(`${hermesUrl}/claude/limits`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`agente → ${res.status}`);
    const data = (await res.json()) as ClaudeLimits;
    return NextResponse.json(data);
  } catch (error) {
    console.error("Fallo al leer los límites del plan (agente):", error);
    const message = error instanceof Error ? error.message : "Error desconocido";
    // Mismo contrato que antes (lectura directa): 200 siempre, con
    // available:false — ClaudeUsage.tsx/LabStatusBar.tsx muestran `reason`
    // en vez de tratarlo como caída del endpoint.
    return NextResponse.json(
      {
        available: false,
        generatedAt: new Date().toISOString(),
        plan: null,
        session: null,
        weekly: [],
        reason: message,
      } satisfies ClaudeLimits,
      { status: 200 },
    );
  }
}
