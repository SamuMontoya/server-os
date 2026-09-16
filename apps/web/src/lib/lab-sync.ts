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
  /** Papelera (migración 032 del agente) — ver ThreadMeta en chat-threads.ts. */
  status: "active" | "trashed";
  deletedAt: number | null;
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

/**
 * `status` (papelera, migración 032 del agente): "active" trae los chats de
 * verdad (comportamiento de siempre, default); "trashed" trae la papelera de
 * OTROS dispositivos de la misma cuenta — usado por `syncTrashFromServer` en
 * laboratorio/page.tsx para que restaurar/ver lo eliminado no dependa de
 * haber sido ESTE navegador el que lo borró.
 */
export async function fetchRemoteThreads(
  project: string,
  status: "active" | "trashed" = "active",
): Promise<RemoteThreadList | null> {
  try {
    const res = await hermesFetch(
      `/chat/threads?project=${encodeURIComponent(project)}&status=${status}`,
    );
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
  // Un chat sin NINGÚN mensaje enviado no debe existir del otro lado — sin
  // esto, crear un chat nuevo (o abrir la app y que quede uno en blanco
  // activo) ya lo mandaba al agente, y aparecía como una entrada fantasma
  // "Chat nuevo" en la lista de otro dispositivo antes de que Samu escribiera
  // una palabra. A diferencia de `worthKeeping` en lab-persist.ts (que SÍ
  // guarda un borrador sin enviar, para no perderlo en ESTE navegador), acá
  // el criterio es más estricto a propósito: lo que se sincroniza entre
  // dispositivos es la CONVERSACIÓN, no el borrador de nadie.
  if (thread.messages.length === 0) return;
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

/** Ya NO borra de verdad del lado del servidor (ver migración 032 en
 *  chat-threads.ts del agente): manda el chat a `trashed` con la hora del
 *  borrado. Mismo fire-and-forget de siempre — lo local (`status: "trashed"`
 *  en lab-persist.ts) manda la UI sin esperar a esta llamada. */
export function pushRemoteDelete(id: string): void {
  void hermesFetch(`/chat/threads/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

/** Papelera: saca un chat de `trashed` en el servidor. Igual de
 *  fire-and-forget que `pushRemoteDelete` — si falla (sin red, sin sesión),
 *  el chat sigue restaurado LOCALMENTE (lo que ve Samu) y el mirror del
 *  servidor queda desincronizado hasta el próximo `pushRemoteThread` de ese
 *  chat, exactamente la misma tolerancia a fallos que el resto de este
 *  módulo. */
export function pushRemoteRestore(id: string): void {
  void hermesFetch(`/chat/threads/${encodeURIComponent(id)}/restore`, { method: "POST" }).catch(
    () => {},
  );
}

export function pushRemoteActive(project: string, chatId: string): void {
  void hermesFetch(`/chat/active`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, chatId }),
  }).catch(() => {});
}
