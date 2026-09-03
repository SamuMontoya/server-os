import type {
  ProjectContext,
  ChatSessionSummary,
  ChatSessionDetail,
  ChatToolStep,
  ClaudeSessionSummary,
  ClaudeSessionDetail,
  MachinePresence,
  Task,
  TaskState,
  TaskExecution,
  TaskExecutionSummary,
  VaultDoc,
} from "@hermes/shared";
import { downloadText } from "./download";
import { uuid } from "./uuid";

/**
 * Cliente del agent server (local o remoto vía Tailscale).
 * Portado del contrato Hermes original (zylen-web/hermes.service.ts):
 * OpenAI-compatible SSE + X-Hermes-Session-Id para memoria de sesión.
 *
 * Multi-Mac: la URL base es DINÁMICA — el selector de máquina puede apuntar
 * el dashboard al agente de otra Mac (override en localStorage). Si el agente
 * exige HERMES_API_KEY, el Bearer va en cada request (y como ?key= en los SSE,
 * porque EventSource no puede mandar headers).
 */
const DEFAULT_HERMES_URL = (
  process.env.NEXT_PUBLIC_HERMES_URL || "http://localhost:8650"
).replace(/\/$/, "");

import { getAccessToken } from "@/lib/auth/token";

const AGENT_URL_KEY = "hermes_agent_url";

/**
 * Agente FIJO: el dashboard habla siempre con el suyo y no se puede cambiar.
 * Es lo correcto cuando el dashboard lo sirve el mismo servidor que corre el
 * agente — ahí un selector de máquinas solo sirve para apuntar a un agente
 * apagado y quedarse "Desconectado" sin explicación.
 */
export const AGENT_PINNED = process.env.NEXT_PUBLIC_HERMES_PIN_AGENT === "1";

// Un override viejo sobrevive en el navegador aunque se quite el selector, así
// que al fijar el agente se PURGA al cargar. Sin esto, quien ya tenía uno
// guardado seguía apuntando a la máquina equivocada para siempre.
if (AGENT_PINNED && typeof window !== "undefined") {
  try {
    if (localStorage.getItem(AGENT_URL_KEY)) {
      localStorage.removeItem(AGENT_URL_KEY);
      console.info("[hermes] agente fijo: se descartó el override guardado");
    }
  } catch {
    /* sin localStorage */
  }
}

/** URL del agente activo: override del selector de máquina o el env local. */
export function getHermesUrl(): string {
  if (AGENT_PINNED) return DEFAULT_HERMES_URL;
  try {
    const override = localStorage.getItem(AGENT_URL_KEY);
    if (override) return override.replace(/\/$/, "");
  } catch {
    /* SSR/prerender: sin localStorage */
  }
  return DEFAULT_HERMES_URL;
}

/** Fija (o limpia con null) el agente activo. El selector recarga después. */
export function setHermesUrl(url: string | null): void {
  try {
    if (url && url.replace(/\/$/, "") !== DEFAULT_HERMES_URL) {
      localStorage.setItem(AGENT_URL_KEY, url.replace(/\/$/, ""));
    } else {
      localStorage.removeItem(AGENT_URL_KEY);
    }
  } catch {
    /* noop */
  }
}

/**
 * Credencial para el agente. Prefiere el JWT de la sesión y solo cae a la
 * HERMES_API_KEY estática si no hay sesión.
 *
 * El orden importa: la key va INCRUSTADA en el bundle, así que cualquiera que
 * cargue la página se la lleva y revocarla obliga a rotarla en todas las
 * máquinas. El JWT ata cada petición a una identidad, caduca solo y se revoca
 * quitando el usuario. La key se mantiene como respaldo para el modo sin
 * login (LAN de casa) y para clientes que no son el navegador.
 */
export function getHermesKey(): string {
  const jwt = getAccessToken();
  if (jwt) return jwt;
  return process.env.NEXT_PUBLIC_HERMES_API_KEY || "";
}

function authHeaders(): Record<string, string> {
  const key = getHermesKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** fetch contra el agente activo con el Bearer inyectado (si hay key). */
export function hermesFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getHermesUrl()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
}

/** URL para EventSource: anexa ?key= porque SSE no admite headers. */
export function sseUrl(path: string): string {
  const key = getHermesKey();
  if (!key) return `${getHermesUrl()}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${getHermesUrl()}${path}${sep}key=${encodeURIComponent(key)}`;
}

const SESSION_KEY = "hermes_os_session_id";

export function getSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = uuid();
    localStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return uuid();
  }
}

export function resetSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* noop */
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Stream de chat contra el agente local (SSE estilo OpenAI). */
export async function streamChat(
  messages: ChatMessage[],
  onChunk: (delta: string) => void,
  opts?: {
    project?: string | null;
    signal?: AbortSignal;
    /** Clave de sesión del cliente (una por tab); default: la global. */
    sessionKey?: string;
    /** Sesión SDK a resumir (uuid del jsonl); null = conversación nueva. */
    resume?: string | null;
    /** Recibe el session id real del SDK apenas el agente lo anuncia. */
    onSession?: (sdkSessionId: string) => void;
    /** Recibe cada paso agéntico (tool_use) del turno, en orden. */
    onTool?: (step: ChatToolStep) => void;
  },
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Hermes-Session-Id": opts?.sessionKey || getSessionId(),
    // "new" fuerza sesión SDK fresca; un uuid resume esa sesión exacta.
    "X-Hermes-Resume": opts?.resume || "new",
  };
  // Foco de conversación: el agente centra el system prompt en este proyecto.
  if (opts?.project) headers["X-Hermes-Project"] = opts.project;

  const response = await hermesFetch(`/v1/chat/completions`, {
    method: "POST",
    signal: opts?.signal,
    headers,
    body: JSON.stringify({ messages, stream: true }),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `OS no responde (${response.status}). ¿Está corriendo el agent server en ${getHermesUrl()}?`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEvent = (rawEvent: string): boolean => {
    const dataLines = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (!dataLines.length) return false;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return true;
    try {
      const parsed = JSON.parse(data);
      // Anuncio del session id del SDK (evento propio de Hermes en el stream).
      const sid = parsed?.hermes?.session_id;
      if (typeof sid === "string" && sid) opts?.onSession?.(sid);
      // Paso agéntico (tool_use) del turno — mismo sobre `hermes`.
      const tool = parsed?.hermes?.tool;
      if (tool && typeof tool.name === "string") opts?.onTool?.(tool as ChatToolStep);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) onChunk(delta);
    } catch {
      /* keep-alive */
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (handleEvent(rawEvent)) {
        await reader.cancel();
        return;
      }
    }
  }
  if (buffer.trim()) handleEvent(buffer);
}

// ── Claude Code (CLI real) ─────────────────────────────────────────────
export interface ClaudeExecConfig {
  model: string;
  effort: string;
  permissionMode: string;
}

/**
 * Inicia una corrida headless de `claude -p`. Si `resumeSessionId` viene, resume
 * esa sesión; si no, crea una nueva. Devuelve el run_id (para el stream) y el
 * session_id (para marcar la sesión activa en el panel).
 */
export async function claudeStartRun(
  prompt: string,
  cfg: ClaudeExecConfig,
  project?: string | null,
  resumeSessionId?: string | null,
): Promise<{ runId: string; sessionId: string }> {
  const res = await hermesPost<{ run_id: string; session_id: string }>("/claude/run", {
    prompt,
    ...cfg,
    project: project ?? undefined,
    resumeSessionId: resumeSessionId ?? undefined,
  });
  return { runId: res.run_id, sessionId: res.session_id };
}

/** URL del stream SSE de una corrida embebida (con ?key= si aplica). */
export function claudeRunStreamUrl(runId: string): string {
  return sseUrl(`/claude/run/${runId}/stream`);
}

/** Detiene una corrida en curso (kill del proceso `claude -p`). */
export async function claudeKillRun(runId: string): Promise<boolean> {
  try {
    await hermesPost(`/claude/run/${encodeURIComponent(runId)}/kill`);
    return true;
  } catch {
    return false;
  }
}

// ── Sesiones de Claude Code (CLI) por proyecto ─────────────────────────
/** Lista las sesiones de Claude Code de un proyecto (más recientes primero). */
export async function listClaudeSessions(
  project?: string | null,
): Promise<ClaudeSessionSummary[]> {
  try {
    return await hermesGet<ClaudeSessionSummary[]>(
      `/claude/sessions/${encodeURIComponent(project || "general")}`,
    );
  } catch {
    return [];
  }
}

/** Trae el detalle (con transcript) de una sesión para reabrirla. */
export async function getClaudeSession(
  project: string | null | undefined,
  id: string,
): Promise<ClaudeSessionDetail | null> {
  try {
    return await hermesGet<ClaudeSessionDetail>(
      `/claude/sessions/${encodeURIComponent(project || "general")}/${encodeURIComponent(id)}`,
    );
  } catch {
    return null;
  }
}

/** Borra el registro local de una sesión de Claude Code. */
export async function deleteClaudeSession(
  project: string | null | undefined,
  id: string,
): Promise<void> {
  await hermesFetch(
    `/claude/sessions/${encodeURIComponent(project || "general")}/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  ).catch(() => {});
}

// ── Sesiones de la consola: DIRECTO de ~/.claude/projects ──────────────
// La misma fuente que ve `claude` abierto en el repo del proyecto (Cursor).

/** Lista las sesiones del cwd del proyecto (más recientes primero). */
export async function listChatSessions(
  project?: string | null,
): Promise<ChatSessionSummary[]> {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  return hermesGet<ChatSessionSummary[]>(`/chat/sessions${q}`);
}

/** Lee una sesión completa (mensajes de texto en orden) para abrirla en un tab. */
export async function getChatSession(
  project: string | null | undefined,
  id: string,
): Promise<ChatSessionDetail | null> {
  try {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    return await hermesGet<ChatSessionDetail>(
      `/chat/sessions/${encodeURIComponent(id)}${q}`,
    );
  } catch {
    return null;
  }
}

// ── Contexto operativo de un proyecto (skills · MCP · tools) ───────────
/** Lee skills, servers MCP, herramientas y comandos del repo local del proyecto. */
export async function getProjectContext(slug: string): Promise<ProjectContext> {
  return hermesGet<ProjectContext>(`/projects/${encodeURIComponent(slug)}/context`);
}

function blobExt(blob: Blob): string {
  const t = (blob.type || "").toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4") || t.includes("m4a")) return "m4a";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("wav")) return "wav";
  if (t.includes("ogg")) return "ogg";
  return "webm";
}

// ── Dictado del composer: clip grabado → texto CON puntuación ──────────

/**
 * Re-transcribe en el servidor el clip que se grabó mientras el usuario
 * dictaba. La Web Speech API del navegador da el texto en vivo pero apenas
 * puntúa en español; Scribe/Whisper sí, y no tienen el corte por tiempo de
 * Chrome. Devuelve `null` cuando el clip venía vacío (toque accidental del
 * botón), para que el consumidor sepa que no debe borrar lo que ya tenía.
 */
export async function transcribeDictation(
  blob: Blob,
): Promise<{ text: string; provider: string | null } | null> {
  const form = new FormData();
  form.append("audio", blob, `dictado.${blobExt(blob)}`);
  const res = await hermesFetch("/dictado/transcribir", { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      (detail as { error?: string } | null)?.error ?? `dictado → ${res.status}`,
    );
  }
  const data = (await res.json()) as { text?: string; provider?: string | null; empty?: boolean };
  if (data.empty || !data.text?.trim()) return null;
  return { text: data.text.trim(), provider: data.provider ?? null };
}

// ── Tracker de tareas por proyecto ─────────────────────────────────────

export interface RunRef {
  runId: string;
  sessionId: string;
  slug: string;
}

/** Lista tareas (tablero). Filtrable por proyecto y estado. */
export async function listTasks(opts: { project?: string; status?: TaskState } = {}): Promise<Task[]> {
  const q = new URLSearchParams();
  if (opts.project) q.set("project", opts.project);
  if (opts.status) q.set("status", opts.status);
  const qs = q.toString();
  try {
    return await hermesGet<Task[]>(`/tracker/tasks${qs ? `?${qs}` : ""}`);
  } catch {
    return [];
  }
}

export async function getTask(id: number): Promise<Task | null> {
  try {
    return await hermesGet<Task>(`/tracker/tasks/${id}`);
  } catch {
    return null;
  }
}

/** Crea una tarea manual en un proyecto. */
export async function createTask(project: string, title: string, detail?: string): Promise<Task | null> {
  try {
    return await hermesPost<Task>("/tracker/tasks", { project, title, detail });
  } catch {
    return null;
  }
}

/** Cambia el estado (completar/ignorar/reabrir). */
export async function setTaskStatus(id: number, status: TaskState): Promise<Task | null> {
  try {
    return await hermesPost<Task>(`/tracker/tasks/${id}/status`, { status });
  } catch {
    return null;
  }
}

/** Lanza `claude -p` con la tarea; devuelve el run para abrir su stream. */
export async function executeTask(id: number): Promise<RunRef | null> {
  try {
    const r = await hermesPost<{ run_id: string; session_id: string; slug: string }>(
      `/tracker/tasks/${id}/execute`,
    );
    return { runId: r.run_id, sessionId: r.session_id, slug: r.slug };
  } catch {
    return null;
  }
}

/**
 * Continúa/envía otro prompt a la tarea: resume su sesión de Claude Code con un
 * run nuevo (misma conversación). Sin prompt, envía un "continúa" por defecto.
 */
export async function continueTask(id: number, prompt?: string): Promise<RunRef | null> {
  try {
    const r = await hermesPost<{ run_id: string; session_id: string; slug: string }>(
      `/tracker/tasks/${id}/continue`,
      { prompt },
    );
    return { runId: r.run_id, sessionId: r.session_id, slug: r.slug };
  } catch {
    return null;
  }
}

/** Historial de ejecuciones de una tarea (memoria: prompt · análisis · resultado). */
export async function listTaskExecutions(taskId: number): Promise<TaskExecutionSummary[]> {
  try {
    return await hermesGet<TaskExecutionSummary[]>(`/tracker/tasks/${taskId}/executions`);
  } catch {
    return [];
  }
}

/** Documento completo de una ejecución (con markdown para renderizar). */
export async function getTaskExecution(
  project: string,
  id: string,
): Promise<TaskExecution | null> {
  try {
    return await hermesGet<TaskExecution>(
      `/tracker/executions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`,
    );
  } catch {
    return null;
  }
}

/** Importa las "Tareas Pendientes" ya escritas en la nota del proyecto. */
export async function importVaultTasks(project: string): Promise<{ imported: number }> {
  try {
    return await hermesPost<{ imported: number }>(`/tracker/import/${encodeURIComponent(project)}`);
  } catch {
    return { imported: 0 };
  }
}

// Resuelve una referencia .md del vault (wikilink o ruta) para el visor Notion.
export function getVaultDoc(ref: string, project?: string): Promise<VaultDoc> {
  const q = new URLSearchParams({ ref });
  if (project) q.set("project", project);
  return hermesGet<VaultDoc>(`/vault/doc?${q.toString()}`);
}

// ── Helpers REST simples ───────────────────────────────────────────────
export async function hermesGet<T>(path: string): Promise<T> {
  const res = await hermesFetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function hermesPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await hermesFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function hermesDelete<T>(path: string): Promise<T> {
  const res = await hermesFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function hermesPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await hermesFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

// ── Capa de datos del rediseño (dashboard/strip + memoria) ─────────────
import type {
  DashboardSnapshot,
  KnowledgeHit,
  KnowledgeSource,
  KnowledgeStats,
  TrackerSummary,
} from "@hermes/shared";

/** Búsqueda semántica unificada (memorias+reuniones+ejecuciones+chats+vault). */
export function searchKnowledge(
  query: string,
  opts?: { sources?: KnowledgeSource[]; project?: string; limit?: number },
): Promise<KnowledgeHit[]> {
  return hermesPost<KnowledgeHit[]>("/knowledge/search", { query, ...opts });
}

/** Conteos reales de la base de conocimiento (panel MEMORIA ACTIVA). */
export function getKnowledgeStats(): Promise<KnowledgeStats> {
  return hermesGet<KnowledgeStats>("/knowledge/stats");
}

/** Snapshot único del dashboard (strip inferior + presencia + jobs + clima). */
export function getDashboard(): Promise<DashboardSnapshot> {
  return hermesGet<DashboardSnapshot>("/dashboard");
}

/** Conteos del tracker por estado (progreso real de un proyecto). */
export function getTrackerSummary(project?: string): Promise<TrackerSummary> {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  return hermesGet<TrackerSummary>(`/tracker/summary${q}`);
}

// ── Máquinas de la red interna (multi-PC) ───────────────────────────────
// El dashboard lo sirve UNA máquina y lo abren varias: cada browser elige a
// qué agente le habla (override en localStorage, que es por-máquina). La lista
// NO se hornea en una env — la publica cada agente en su heartbeat.

/**
 * Máquinas conocidas según el agente activo (él lee agent_presence). La que
 * viene con `self: true` es justamente la que está respondiendo: así el
 * selector sabe cuál marcar sin comparar URLs (localhost vs IP LAN).
 */
export async function listMachines(): Promise<MachinePresence[]> {
  try {
    const { machines } = await hermesGet<{ machines: MachinePresence[] }>("/machines");
    return machines ?? [];
  } catch {
    return [];
  }
}

/**
 * ¿Contesta ese agente AHORA? /health no exige auth y devuelve el nombre de la
 * máquina: un heartbeat viejo en Supabase no prueba que se le pueda hablar
 * desde ESTE browser (otra subred, firewall, PC dormido).
 */
export async function probeMachine(
  baseUrl: string,
): Promise<{ ok: boolean; machine?: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { machine?: string };
    return { ok: true, machine: body.machine };
  } catch {
    return { ok: false };
  }
}
