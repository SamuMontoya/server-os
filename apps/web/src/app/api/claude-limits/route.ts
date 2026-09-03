import { NextResponse } from "next/server";
import type { ClaudeLimits } from "@hermes/shared";

/**
 * Proxy fino al agente: la lectura real de ~/.claude/* vive en
 * apps/agent/src/claude-limits.ts (GET /claude/limits), porque este route
 * handler puede correr en Vercel, sin ese disco. Aquí solo se reenvía.
 *
 * Base URL server-side, SIN localStorage (a diferencia de
 * apps/web/src/lib/hermes.ts, que es cliente y soporta el selector de
 * máquina): mismo default que ese archivo, resuelto una sola vez por env.
 */
const HERMES_URL = (process.env.NEXT_PUBLIC_HERMES_URL || "http://localhost:8650").replace(
  /\/$/,
  "",
);

function authHeaders(): Record<string, string> {
  const key = process.env.HERMES_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Consulta en vivo los límites del plan; nunca se pre-renderiza.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${HERMES_URL}/claude/limits`, {
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
