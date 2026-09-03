import { NextResponse } from "next/server";
import type { ClaudeUsageData } from "@hermes/shared";

/**
 * Proxy fino al agente: el escaneo real de ~/.claude/projects/*.jsonl vive en
 * apps/agent/src/claude-usage.ts (GET /claude/usage), porque este route
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

// Lee ~/.claude en cada request (uso en vivo); nunca se pre-renderiza.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${HERMES_URL}/claude/usage`, {
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
