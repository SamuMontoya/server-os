/**
 * Espejo server-side de los chats de /laboratorio (chat_threads +
 * chat_active_chat), scoped por usuario — ver migración 027. Sin esto, el
 * historial de chats vive SOLO en localStorage del navegador (lib/lab-persist.ts
 * en apps/web) y abrir la web desde otro dispositivo con la misma cuenta no ve
 * nada. Esta capa es lo que permite "seguir el chat del Mac desde el iPhone".
 *
 * Todo best-effort: sin Supabase configurado, cada función devuelve el
 * equivalente a "no hay nada guardado" en vez de lanzar — el laboratorio debe
 * seguir funcionando 100% local (localStorage) aunque esto falle.
 *
 * Papelera (migración 032, pedido de Jaime 2026-09-16): "eliminar" un chat ya
 * no es un DELETE físico — pasa a `status='trashed'` con `deleted_at`, se
 * lista aparte (`listThreadsMeta(..., { status: "trashed" })`), puede
 * restaurarse (`restoreThread`) y se purga solo a los 30 días
 * (`purgeExpiredTrashedThreads`, colgado como job en index.ts). Cada función
 * acepta un `client` inyectable (por defecto el singleton `supabase`) solo
 * para poder testear la lógica de filtros/fechas con un doble en
 * chat-threads.test.ts, sin pegarle a una base real.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";

/** Subconjunto de SupabaseClient que este módulo realmente usa — permite
 *  inyectar un doble en tests sin arrastrar el tipo completo de la lib. */
export type ThreadsClient = Pick<SupabaseClient, "from">;

export type ThreadStatus = "active" | "trashed";

export interface ThreadMeta {
  id: string;
  title: string | null;
  updatedAt: number;
  model: string | null;
  sdkSessionId: string | null;
  pendingTurn: { id: string; seq: number } | null;
  status: ThreadStatus;
  /** Instante del soft-delete; null si sigue activo. */
  deletedAt: number | null;
}

export interface FullThread extends ThreadMeta {
  project: string;
  sessionKey: string;
  messages: unknown[];
  draft: string;
}

interface ThreadRow {
  id: string;
  title: string | null;
  updated_at: string;
  model: string | null;
  sdk_session_id: string | null;
  pending_turn: { id: string; seq: number } | null;
  project: string;
  session_key: string;
  messages: unknown[];
  draft: string;
  status: string;
  deleted_at: string | null;
}

function toMeta(row: ThreadRow): ThreadMeta {
  return {
    id: row.id,
    title: row.title,
    updatedAt: new Date(row.updated_at).getTime(),
    model: row.model,
    sdkSessionId: row.sdk_session_id,
    pendingTurn: row.pending_turn,
    status: row.status === "trashed" ? "trashed" : "active",
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
  };
}

function toFull(row: ThreadRow): FullThread {
  return {
    ...toMeta(row),
    project: row.project,
    sessionKey: row.session_key,
    messages: Array.isArray(row.messages) ? row.messages : [],
    draft: row.draft,
  };
}

/** Techo de filas listadas por request — igual para "activos" y "papelera":
 *  ambas listas comparten la misma pantalla (LabChatsScreen) y el mismo
 *  orden de magnitud de uso. */
const LIST_LIMIT = 60;

export async function listThreadsMeta(
  userId: string,
  project: string,
  opts: { status?: ThreadStatus } = {},
  client: ThreadsClient | null = supabase,
): Promise<ThreadMeta[]> {
  if (!client) return [];
  const status = opts.status ?? "active";
  const { data, error } = await client
    .from("chat_threads")
    .select("id, title, updated_at, model, sdk_session_id, pending_turn, status, deleted_at")
    .eq("user_id", userId)
    .eq("project", project)
    .eq("status", status)
    // La papelera se lee por "más reciente al borrar primero" (deleted_at);
    // los activos, por última actividad (updated_at) — sigue igual que antes.
    .order(status === "trashed" ? "deleted_at" : "updated_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) {
    console.error("[chat-threads] list:", error.message);
    return [];
  }
  return (data ?? []).map((r) => toMeta(r as ThreadRow));
}

export async function getThread(userId: string, id: string): Promise<FullThread | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[chat-threads] get:", error.message);
    return null;
  }
  return data ? toFull(data as ThreadRow) : null;
}

export interface UpsertThreadInput {
  project?: string;
  sessionKey?: string;
  sdkSessionId?: string | null;
  title?: string | null;
  messages?: unknown[];
  draft?: string;
  model?: string | null;
  pendingTurn?: { id: string; seq: number } | null;
  updatedAt?: number;
}

export async function upsertThread(
  userId: string,
  id: string,
  input: UpsertThreadInput,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from("chat_threads").upsert({
    id,
    user_id: userId,
    project: input.project || "general",
    session_key: input.sessionKey || "",
    sdk_session_id: input.sdkSessionId ?? null,
    title: input.title ?? null,
    messages: input.messages ?? [],
    draft: input.draft ?? "",
    model: input.model ?? null,
    pending_turn: input.pendingTurn ?? null,
    updated_at: new Date(input.updatedAt ?? Date.now()).toISOString(),
  });
  if (error) console.error("[chat-threads] upsert:", error.message);
}

/** 30 días entre "eliminar" y la purga definitiva — ver migración 032 y el
 *  job "chat-trash-purge" en index.ts. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * "Eliminar" un chat: ya NO borra la fila (ver histórico en el comentario de
 * cabecera de este archivo) — la marca `trashed` con la hora del borrado.
 * Queda visible en la papelera (`listThreadsMeta(..., { status: "trashed" })`)
 * y restaurable (`restoreThread`) hasta que `purgeExpiredTrashedThreads` la
 * borre de verdad a los 30 días.
 */
export async function deleteThread(
  userId: string,
  id: string,
  client: ThreadsClient | null = supabase,
): Promise<void> {
  if (!client) return;
  const { error } = await client
    .from("chat_threads")
    .update({ status: "trashed", deleted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) console.error("[chat-threads] delete:", error.message);
}

/**
 * Saca un chat de la papelera: vuelve a `active` y limpia `deleted_at`. Solo
 * afecta filas que estén `trashed` (`.eq("status", "trashed")`) — restaurar
 * un chat que ya está activo, o que no existe (ya purgado), no hace nada y
 * `ok` sale en `false` para que la UI pueda avisar "ya no está" en vez de
 * fingir que funcionó.
 */
export async function restoreThread(
  userId: string,
  id: string,
  client: ThreadsClient | null = supabase,
): Promise<boolean> {
  if (!client) return false;
  const { data, error } = await client
    .from("chat_threads")
    .update({ status: "active", deleted_at: null })
    .eq("user_id", userId)
    .eq("id", id)
    .eq("status", "trashed")
    .select("id");
  if (error) {
    console.error("[chat-threads] restore:", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** Filas por tanda de purga y techo de tandas por corrida. Sin esto, un
 *  backlog grande (p.ej. el job estuvo caído semanas) dispararía un solo
 *  DELETE gigante que puede tardar de más y competir por la conexión con el
 *  resto del server; lo que sobra del techo queda para la corrida siguiente
 *  (cada hora, ver index.ts) sin que nadie tenga que intervenir. */
export const PURGE_BATCH_SIZE = 500;
export const PURGE_MAX_BATCHES = 20;

/**
 * Job periódico (ver index.ts): purga DE VERDAD lo que lleva en la papelera
 * más de `TRASH_RETENTION_MS`. Sin scope de usuario a propósito — corre una
 * vez por todo el server, como el resto de `jobs.ts`. `nowMs`/`client` son
 * inyectables para poder testear el corte de 30 días sin esperar de verdad ni
 * pegarle a Supabase (ver chat-threads.test.ts).
 *
 * Va en tandas de `PURGE_BATCH_SIZE` (ver arriba) en vez de un DELETE único:
 * primero selecciona candidatos (`status='trashed'` y ya vencidos) y recién
 * ahí los borra por id. El DELETE final repite los MISMOS filtros
 * (`status='trashed'` y `deleted_at < cutoff`), no solo el id — si un chat se
 * restauró (o se volvió a borrar, refrescando su `deleted_at`) en la ventana
 * entre el SELECT y el DELETE de su tanda, ese re-chequeo hace que sobreviva
 * en vez de purgarse por un estado que ya no es el actual.
 */
export async function purgeExpiredTrashedThreads(
  nowMs: number = Date.now(),
  client: ThreadsClient | null = supabase,
): Promise<{ purged: number } | null> {
  if (!client) return null;
  const cutoff = new Date(nowMs - TRASH_RETENTION_MS).toISOString();
  let purged = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
    const { data: candidates, error: selectError } = await client
      .from("chat_threads")
      .select("id")
      .eq("status", "trashed")
      .lt("deleted_at", cutoff)
      .limit(PURGE_BATCH_SIZE);
    if (selectError) {
      console.error("[chat-threads] purge (select):", selectError.message);
      return { purged };
    }
    const ids = (candidates ?? []).map((r) => (r as { id: string }).id);
    if (ids.length === 0) break;
    const { data, error } = await client
      .from("chat_threads")
      .delete()
      .eq("status", "trashed")
      .lt("deleted_at", cutoff)
      .in("id", ids)
      .select("id");
    if (error) {
      console.error("[chat-threads] purge (delete):", error.message);
      return { purged };
    }
    purged += data?.length ?? 0;
    if (ids.length < PURGE_BATCH_SIZE) break;
  }
  return { purged };
}

export async function getActiveChat(userId: string, project: string): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("chat_active_chat")
    .select("chat_id")
    .eq("user_id", userId)
    .eq("project", project)
    .maybeSingle();
  if (error) {
    console.error("[chat-threads] active get:", error.message);
    return null;
  }
  return data?.chat_id ?? null;
}

export async function setActiveChat(
  userId: string,
  project: string,
  chatId: string,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from("chat_active_chat")
    .upsert({ user_id: userId, project, chat_id: chatId, updated_at: new Date().toISOString() });
  if (error) console.error("[chat-threads] active set:", error.message);
}
