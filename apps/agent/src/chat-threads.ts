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
 */
import { supabase } from "./supabase.js";

export interface ThreadMeta {
  id: string;
  title: string | null;
  updatedAt: number;
  model: string | null;
  sdkSessionId: string | null;
  pendingTurn: { id: string; seq: number } | null;
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
}

function toMeta(row: ThreadRow): ThreadMeta {
  return {
    id: row.id,
    title: row.title,
    updatedAt: new Date(row.updated_at).getTime(),
    model: row.model,
    sdkSessionId: row.sdk_session_id,
    pendingTurn: row.pending_turn,
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

export async function listThreadsMeta(userId: string, project: string): Promise<ThreadMeta[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("chat_threads")
    .select("id, title, updated_at, model, sdk_session_id, pending_turn")
    .eq("user_id", userId)
    .eq("project", project)
    .order("updated_at", { ascending: false })
    .limit(60);
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

export async function deleteThread(userId: string, id: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from("chat_threads")
    .delete()
    .eq("user_id", userId)
    .eq("id", id);
  if (error) console.error("[chat-threads] delete:", error.message);
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
