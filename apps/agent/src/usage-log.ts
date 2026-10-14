/**
 * Registro de consumo por turno, atribuido a un correo — MVP 8, K1 (pedido
 * de Jaime 2026-10-14: "arma uno basado en anthropic, con métricas propias
 * también del correo que lo usa"). Ver migración 036_turn_usage.sql para el
 * porqué de `user_email` sin verificar por JWT (es una etiqueta de reporte,
 * no un límite de seguridad).
 *
 * `TurnUsage` (session.ts) ya trae entrada/salida/cache/costoUsd por turno
 * — este módulo solo lo guarda en Supabase, best-effort (nunca puede romper
 * un turno si Supabase está caído o sin configurar).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase, hasSupabase } from "./supabase.js";
import type { TurnUsage } from "./agent/session.js";

/** Mismo criterio que `ThreadsClient` en chat-threads.ts: solo el subconjunto
 *  de la API fluida que este módulo de verdad usa — así un test puede pasar
 *  un doble en memoria sin tocar una base real. */
export type UsageClient = Pick<SupabaseClient, "from">;

export async function logTurnUsage(
  args: {
    userEmail?: string | null;
    project?: string | null;
    model: string;
    usage: TurnUsage;
  },
  client: UsageClient | null = supabase,
): Promise<void> {
  if (!client || (client === supabase && !hasSupabase())) return;
  try {
    const { error } = await client.from("turn_usage").insert({
      user_email: args.userEmail?.toLowerCase().trim() || null,
      project: args.project || null,
      model: args.model,
      input_tokens: args.usage.entrada,
      output_tokens: args.usage.salida,
      cache_read_tokens: args.usage.cacheLeido,
      cache_write_tokens: args.usage.cacheEscrito,
      cost_usd: args.usage.costoUsd ?? 0,
    });
    if (error) console.error("[usage-log] insert falló:", error.message);
  } catch (err) {
    console.error("[usage-log] no se pudo guardar:", err);
  }
}

/** Una fila agregada del reporte "por correo" — totales desde `createdAfter`
 *  (o desde siempre, si no se pasa). */
export interface EmailUsageTotal {
  email: string; // "(sin correo)" para las filas con user_email null
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

/** Trae y agrega en memoria (el volumen de esta instancia — un puñado de
 *  personas — no justifica un `group by` en SQL todavía; si el volumen
 *  crece, esto es lo primero que habría que mover a una vista). */
export async function getUsageByEmail(
  createdAfter?: Date,
  client: UsageClient | null = supabase,
): Promise<EmailUsageTotal[]> {
  if (!client || (client === supabase && !hasSupabase())) return [];
  let query = client
    .from("turn_usage")
    .select("user_email, input_tokens, output_tokens, cost_usd");
  if (createdAfter) query = query.gte("created_at", createdAfter.toISOString());

  const { data, error } = await query;
  if (error || !data) {
    if (error) console.error("[usage-log] getUsageByEmail falló:", error.message);
    return [];
  }

  const byEmail = new Map<string, EmailUsageTotal>();
  for (const row of data as {
    user_email: string | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }[]) {
    const email = row.user_email || "(sin correo)";
    let acc = byEmail.get(email);
    if (!acc) {
      acc = { email, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 };
      byEmail.set(email, acc);
    }
    acc.inputTokens += row.input_tokens;
    acc.outputTokens += row.output_tokens;
    acc.totalTokens += row.input_tokens + row.output_tokens;
    acc.costUsd += Number(row.cost_usd);
    acc.turns += 1;
  }
  return Array.from(byEmail.values()).sort((a, b) => b.costUsd - a.costUsd);
}
