/**
 * Espejo del Laboratorio en el agente (apps/agent/src/chat-threads.ts) — lo
 * que permite abrir la misma cuenta desde otro dispositivo y ver/continuar
 * los mismos chats, en vez de que cada navegador tenga su propio historial
 * aislado en localStorage (lib/lab-persist.ts, que sigue siendo la fuente
 * INMEDIATA — esto es un mirror best-effort por encima, no un reemplazo).
 *
 * Todo acá es fire-and-forget o devuelve null en el fallo: sin sesión (LAN
 * sin login), sin red o con el agente caído, el laboratorio debe seguir
 * funcionando 100% local, exactamente igual que hoy.
 */
import { hermesFetch } from "./hermes";
import type { LabThread, PendingLabTurn } from "./lab-persist";

export interface RemoteThreadMeta {
  id: string;
  title: string | null;
  updatedAt: number;
  model: string | null;
  sdkSessionId: string | null;
  pendingTurn: PendingLabTurn | null;
}

interface RemoteThreadList {
  threads: RemoteThreadMeta[];
  activeId: string | null;
}

interface RemoteFullThread extends RemoteThreadMeta {
  project: string;
  sessionKey: string;
  messages: LabThread["messages"];
  draft: string;
}

export async function fetchRemoteThreads(project: string): Promise<RemoteThreadList | null> {
  try {
    const res = await hermesFetch(`/chat/threads?project=${encodeURIComponent(project)}`);
    if (!res.ok) return null;
    return (await res.json()) as RemoteThreadList;
  } catch {
    return null;
  }
}

export async function fetchRemoteThread(id: string): Promise<LabThread | null> {
  try {
    const res = await hermesFetch(`/chat/threads/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const t = (await res.json()) as RemoteFullThread;
    return {
      id: t.id,
      ...(t.title ? { title: t.title } : {}),
      updatedAt: t.updatedAt,
      sdkSessionId: t.sdkSessionId,
      sessionKey: t.sessionKey,
      messages: t.messages,
      draft: t.draft,
      model: t.model,
      pendingTurn: t.pendingTurn ?? undefined,
    };
  } catch {
    return null;
  }
}

export function pushRemoteThread(project: string, thread: LabThread): void {
  void hermesFetch(`/chat/threads/${encodeURIComponent(thread.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project,
      sessionKey: thread.sessionKey,
      sdkSessionId: thread.sdkSessionId,
      title: thread.title ?? null,
      messages: thread.messages,
      draft: thread.draft,
      model: thread.model,
      pendingTurn: thread.pendingTurn ?? null,
      updatedAt: thread.updatedAt,
    }),
  }).catch(() => {});
}

export function pushRemoteDelete(id: string): void {
  void hermesFetch(`/chat/threads/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

export function pushRemoteActive(project: string, chatId: string): void {
  void hermesFetch(`/chat/active`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, chatId }),
  }).catch(() => {});
}
