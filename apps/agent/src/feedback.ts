/**
 * Buzón de mejoras — reportes de bugs/mejoras del sistema, creados desde el
 * menú de perfil del portal (jaime-os). Mismo patrón que chat-threads.ts:
 * `client` inyectable (por defecto el singleton `supabase`) para poder testear
 * con un mock sin pegarle a la red real.
 *
 * A DIFERENCIA de chat-threads.ts (privado, scoped por user_id en TODO):
 * este es un buzón CENTRALIZADO — "todos los que tengan acceso a este
 * portal" (pedido explícito de Jaime 2026-09-30) ven y pueden mover de
 * estado CUALQUIER reporte, no solo el suyo. `user_id` se guarda igual (para
 * saber quién lo creó, mostrarlo si algún día hace falta), pero NO se usa
 * como filtro en listFeedback/updateFeedbackStatus — solo en deleteFeedback,
 * como salvaguarda mínima para que nadie borre por accidente el reporte de
 * otro (decisión no pedida explícitamente; si Jaime prefiere que cualquiera
 * pueda borrar cualquier reporte, quitar ese `.eq("user_id", ...)` de abajo).
 *
 * Solo samu7montoya@gmail.com puede marcar un reporte como "completado"
 * (validado en routes/feedback.ts contra el email cacheado del JWT, no acá).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";

type FeedbackClient = Pick<SupabaseClient, "from">;

export type FeedbackStatus = "abierto" | "en_revision" | "completado";
export type FeedbackPriority = 1 | 2 | 3;

export interface FeedbackImage {
  url: string;
  uploadedAt: string;
}

export interface Feedback {
  id: string;
  user_id: string;
  project: string;
  title: string;
  description: string;
  priority: FeedbackPriority;
  status: FeedbackStatus;
  images: FeedbackImage[] | null;
  created_at: string;
  updated_at: string;
  completed_by: string | null;
  completed_at: string | null;
}

/** Lista TODO el buzón del proyecto (no solo lo del usuario que pregunta) —
 *  es un tablero compartido, no un historial personal. */
export async function listFeedback(
  project: string,
  status?: FeedbackStatus,
  client: FeedbackClient | null = supabase,
): Promise<Feedback[]> {
  if (!client) return [];
  let query = client
    .from("feedback")
    .select("*")
    .eq("project", project)
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Feedback[];
}

export async function createFeedback(
  userId: string,
  project: string,
  title: string,
  description: string,
  priority: FeedbackPriority = 2,
  images?: FeedbackImage[],
  client: FeedbackClient | null = supabase,
): Promise<Feedback> {
  if (!client) throw new Error("supabase no configurado");
  const { data, error } = await client
    .from("feedback")
    .insert({
      user_id: userId,
      project,
      title,
      description,
      priority,
      images: images ?? [],
    })
    .select()
    .single();
  if (error) throw error;
  return data as Feedback;
}

/** Cambia el estado de CUALQUIER reporte del buzón — no está scoped por
 *  user_id a propósito (ver comentario de cabecera): la puerta real de
 *  "quién puede completar" vive en routes/feedback.ts (email), no acá. */
export async function updateFeedbackStatus(
  feedbackId: string,
  newStatus: FeedbackStatus,
  completedBy?: string,
  client: FeedbackClient | null = supabase,
): Promise<Feedback | null> {
  if (!client) throw new Error("supabase no configurado");
  const payload: Record<string, unknown> = { status: newStatus };
  if (newStatus === "completado") {
    payload.completed_by = completedBy ?? null;
    payload.completed_at = new Date().toISOString();
  } else {
    payload.completed_by = null;
    payload.completed_at = null;
  }
  const { data, error } = await client
    .from("feedback")
    .update(payload)
    .eq("id", feedbackId)
    .select()
    .single();
  if (error) throw error;
  return (data as Feedback) ?? null;
}

/** Borrar SÍ queda scoped al creador (`user_id`): es la única acción
 *  destructiva del buzón, y evitar que cualquiera borre el reporte de otro
 *  es un mínimo razonable aunque Jaime no lo haya pedido en estos términos
 *  — ver el comentario de cabecera si se prefiere abrirlo a todos. */
export async function deleteFeedback(
  feedbackId: string,
  userId: string,
  client: FeedbackClient | null = supabase,
): Promise<void> {
  if (!client) return;
  const { error } = await client.from("feedback").delete().eq("id", feedbackId).eq("user_id", userId);
  if (error) throw error;
}
