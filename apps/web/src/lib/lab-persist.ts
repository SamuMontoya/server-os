/**
 * Los hilos de /laboratorio, guardados en el navegador.
 *
 * Hermano de chat-persist.ts (el mismo patrón, para el chat viejo/deprecado):
 * localStorage propio, recorte por cuota, versión de esquema, y un
 * `pendingTurn` que es lo que permite volver horas después —o que iOS mate la
 * pestaña en segundo plano y la resucite— y re-engancharse al turno que sigue
 * vivo en el servidor, en vez de ver un hilo cortado a media respuesta o, peor,
 * un chat completamente en blanco.
 *
 * Va en su propio storage (no reusa STORAGE_KEY de chat-persist.ts) para no
 * mezclar el hilo de /laboratorio con el del panel viejo: son dos historiales
 * independientes y no deben pisarse.
 *
 * Puro a propósito (nada de React ni de red): la parte con reglas —qué se
 * recorta, en qué orden, qué se descarta— es la que conviene poder testear
 * con node a secas.
 *
 * v2: antes había UN hilo por proyecto (`byProject: Record<projKey, LabThread>`).
 * Samu pidió poder tener VARIOS chats abiertos a la vez por proyecto, cada uno
 * con su turno corriendo en paralelo (igual que los tabs de ChatPanel), más
 * poder borrarlos desde una pantalla de lista con swipe. Eso exige un id
 * propio por hilo — ya no basta la clave del proyecto — así que el mapa pasa
 * a `byChat: Record<chatStorageKey, LabThread>` (clave `"${project}::${chatId}"`)
 * más `activeByProject` para recordar cuál de los chats de cada proyecto es
 * el que se retoma al volver.
 */
import type { ChatToolStep } from "@hermes/shared";

export type LabBlock =
  | { kind: "text"; text: string }
  | { kind: "steps"; steps: ChatToolStep[] };

export type LabMessage = {
  id: number;
  role: "user" | "assistant";
  /** Texto plano del mensaje del usuario. En el asistente vive en `blocks`. */
  content: string;
  /** Respuesta del asistente, en orden cronológico (ver LabBlock). */
  blocks?: LabBlock[];
  /** Imágenes que iban con el mensaje (solo en mensajes del usuario): quedan
   *  visibles en la burbuja, como el adjunto que fueron. */
  images?: { url: string; name: string }[];
  /** Documentos que se indexaron al vuelo con este mensaje (solo usuario):
   *  el archivo original nunca se guardó, así que acá no hay url que
   *  mostrar — solo el resumen (nombre, fragmentos) para la card de la
   *  burbuja. A diferencia de `images`, esto SÍ sobrevive el recorte de
   *  `trimMessage` (no depende de object URLs).
   *
   *  `status` (2026-09-16, auditoría de Jaime): antes solo se guardaban los
   *  `indexedDocs` ("done") — uno que seguía "processing" justo al enviar no
   *  dejaba NINGÚN rastro visual en la burbuja (solo el `pendingNote` de
   *  texto que viaja al MODELO, invisible para Samu), aunque el mensaje
   *  siguiera mencionándolo. Ahora ambos estados entran, y `UserBubble` los
   *  distingue (ver `.lab-doc-card--processing`). `"error"`: el vectorizado
   *  falló DESPUÉS de enviado (detectado por el polling de
   *  `sentPendingDocs` en page.tsx) — sin esto la card se quedaba en
   *  "processing" mintiendo para siempre que eventualmente sería buscable.
   *  `docId`: solo mientras sigue "processing", es lo que ese polling usa
   *  para saber qué preguntarle al servidor; se borra al llegar a un estado
   *  terminal. */
  docs?: {
    name: string;
    status: "done" | "processing" | "error";
    chunks?: number;
    truncated?: boolean;
    docId?: string;
    /** Progreso en vivo mientras sigue "processing" — ver `ChatDocumentJobStatus`
     *  en lib/chat-documents.ts (misma forma, mismo motivo: auditoría 2026-09-17,
     *  "la subida de documentos sigue lenta" — el objetivo no era hacerla
     *  instantánea, Ollama en 1 vCPU sigue siendo Ollama en 1 vCPU, sino que
     *  se VEA avanzar en vez de un spinner mudo). */
    chunksDone?: number;
    chunksTotal?: number;
    etaMs?: number;
  }[];
};

/** Turno del motor que este hilo dejó corriendo (agent/chat-turns.ts). */
export interface PendingLabTurn {
  id: string;
  /** Último `seq` que el cliente alcanzó a ver: el cursor del replay. */
  seq: number;
}

/** Un chat del Laboratorio: una conversación con su propio turno en vuelo. */
export interface LabThread {
  /** Id propio del chat (uuid), estable mientras exista. */
  id: string;
  /** Nombre corto (2-3 palabras) generado por haiku con el PRIMER mensaje —
   *  ver agent/chat-title.ts. Ausente = todavía no llegó (o falló): la lista
   *  cae al recorte del primer mensaje. Se calcula UNA vez por chat: el
   *  título no debe bailar mientras la conversación avanza. */
  title?: string;
  /** Última vez que este chat recibió actividad — ordena la lista y decide
   *  qué se recorta primero cuando hay que liberar cuota. */
  updatedAt: number;
  /** sesión SDK que este hilo resume (uuid del jsonl); null = aún sin crear. */
  sdkSessionId: string | null;
  /** Id de sesión del CLIENTE (agrupa turnos del mismo hilo). Vacío = generar uno nuevo. */
  sessionKey: string;
  messages: LabMessage[];
  draft: string;
  /** Último modelo con el que respondió (ver comentario en laboratorio/page.tsx). */
  model: string | null;
  /** Turno en vuelo. Se persiste: es lo que permite reengancharse al volver. */
  pendingTurn?: PendingLabTurn;
  /** Última vez que Samu ABRIÓ este chat de verdad (no solo que recibió
   *  actividad — eso es `updatedAt`). Decide si la lista lo marca "sin leer"
   *  (pedido de Samu 2026-09-07: antes CUALQUIER chat en reposo llevaba fondo
   *  gris, y debía ser solo el que tiene cambios sin ver). `undefined` = chat
   *  de antes de que existiera este campo, o nunca abierto tras cambiar —
   *  se trata como "leído" (no se marca sin leer de la nada al desplegar
   *  esto: solo mejores nuevos "no leído" a partir de aquí, ver
   *  `listChatsForProject`). Solo local (no viaja al servidor / otro
   *  dispositivo): es una anotación de ESTE navegador, no un dato del chat. */
  seenAt?: number;
  /** Papelera (pedido de Jaime 2026-09-16). `undefined`/`"active"` = chat
   *  normal; `"trashed"` = eliminado, vive en la sección Papelera de
   *  LabChatsScreen hasta que se restaura o se purga solo a los 30 días (ver
   *  `trashedAt` y `TRASH_RETENTION_MS` más abajo). Espejo del `status` de la
   *  migración 032 en el servidor (chat-threads.ts del agente) — mismo
   *  nombre de campo a propósito, para no traducir mentalmente entre las dos
   *  capas. */
  status?: "active" | "trashed";
  /** `Date.now()` de cuando se eliminó. Solo tiene sentido con
   *  `status === "trashed"`; de ahí sale la cuenta regresiva que ve Samu
   *  (LabChatsScreen) y el corte de purga local (ver `TRASH_RETENTION_MS`). */
  trashedAt?: number;
}

/** Estado completo del laboratorio: todos los chats + cuál está activo por proyecto. */
export interface PersistedLab {
  v: number;
  /** clave = `chatStorageKey(project, chat.id)`. */
  byChat: Record<string, LabThread>;
  /** projectKey ("general" o el slug) → id del chat que se retoma al volver. */
  activeByProject: Record<string, string>;
  savedAt: number;
}

/** Forma en memoria que usa laboratorio/page.tsx tras hidratar. */
export interface HydratedLab {
  byChat: Record<string, LabThread>;
  activeByProject: Record<string, string>;
}

export const STORAGE_KEY = "hermes_os_lab_chat";
/** Subir esto invalida lo guardado (cambio de forma incompatible). */
export const SCHEMA_VERSION = 3;

export function chatStorageKey(project: string, chatId: string): string {
  return `${project}::${chatId}`;
}

// ── Recortes ───────────────────────────────────────────────────────────
/** Techo GLOBAL de chats retenidos (antes era por proyecto: con varios chats
 *  por proyecto el límite que importa es el total, no cuántos proyectos hay). */
const MAX_CHATS = 40;
const MAX_MESSAGES = 60;
const MAX_CHARS_PER_BLOCK = 12_000;
const MAX_BYTES = 900_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Mismo plazo que `TRASH_RETENTION_MS` del servidor (chat-threads.ts del
 *  agente) — duplicado a propósito, ver el comentario gemelo en
 *  LabChatsScreen.tsx. Un chat trashed que ya pasó este plazo se descarta al
 *  hidratar (`parseLab`), como si ya lo hubiera purgado el servidor: es un
 *  self-purge local de respaldo, no depende de que el job del agente haya
 *  corrido para que la papelera de ESTE navegador deje de arrastrarlo. */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function trimText(text: string): string {
  return text.length <= MAX_CHARS_PER_BLOCK
    ? text
    : `${text.slice(0, MAX_CHARS_PER_BLOCK)}\n\n[…recortado]`;
}

function trimBlocks(blocks: LabBlock[] | undefined): LabBlock[] | undefined {
  if (!blocks) return blocks;
  return blocks.map((b) => (b.kind === "text" ? { kind: "text" as const, text: trimText(b.text) } : b));
}

/** Tope de documentos por mensaje y de cuánto nombre se guarda de cada uno
 *  (auditoría 2026-09-16): a diferencia de `images`, `docs` no se descartaba
 *  entero al persistir — un mensaje con MAX_DOCUMENTS de por sí (ver
 *  `page.tsx`) más nombres largos podía dejar `serializeLab` sin forma de
 *  bajar de `MAX_BYTES` ni en el cap más chico, y eso tira el localStorage
 *  COMPLETO vía `saveLab`, no solo ese mensaje. */
const MAX_DOCS_PER_MESSAGE = 20;
const MAX_DOC_NAME_CHARS = 200;

function trimDocs(docs: LabMessage["docs"]): LabMessage["docs"] {
  if (!docs) return docs;
  return docs.slice(0, MAX_DOCS_PER_MESSAGE).map((d) =>
    d.name.length <= MAX_DOC_NAME_CHARS ? d : { ...d, name: `${d.name.slice(0, MAX_DOC_NAME_CHARS)}…` },
  );
}

function trimMessage(m: LabMessage): LabMessage {
  // Los `images[].url` son object URLs LOCALES: se revocan al desmontar la
  // página (ver laboratorio/page.tsx), así que tras recargar apuntarían a un
  // blob muerto. Persistirlos dejaría una imagen rota — se descartan.
  const { images: _images, ...rest } = m;
  return { ...rest, content: trimText(m.content), blocks: trimBlocks(m.blocks), docs: trimDocs(m.docs) };
}

function trimThread(thread: LabThread, maxMessages = MAX_MESSAGES): LabThread {
  return { ...thread, messages: thread.messages.slice(-maxMessages).map(trimMessage) };
}

/** Nada que guardar: un hilo virgen no merece ocupar cuota. Un chat trashed
 *  SIEMPRE se guarda mientras no haya expirado (ver `parseLab`) aunque su
 *  contenido esté vacío por el recorte — es lo único que la papelera tiene
 *  para mostrar y restaurar. */
function worthKeeping(thread: LabThread): boolean {
  return (
    thread.status === "trashed" ||
    thread.messages.length > 0 ||
    thread.draft.trim().length > 0 ||
    !!thread.pendingTurn
  );
}

export function serializeLab(
  byChat: Record<string, LabThread>,
  activeByProject: Record<string, string>,
  now: number,
): string | null {
  // Los chats activos (los que se retoman al volver) nunca se descartan por
  // cuota aunque sean los más viejos: perder EL que se está viendo ahora
  // mismo sería mucho peor que perder uno archivado de hace días. Los
  // trashed van SIEMPRE al final (pedido de Jaime 2026-09-16): la papelera es
  // "best effort" — si hace falta espacio, se sacrifica antes que cualquier
  // chat de verdad. El corte real de 30 días vive en `parseLab`; esto solo
  // decide el ORDEN cuando hay que elegir qué se descarta por cuota.
  const activeIds = new Set(Object.values(activeByProject));
  const tier = (t: LabThread): 0 | 1 | 2 =>
    activeIds.has(t.id) ? 2 : t.status === "trashed" ? 0 : 1;
  const entries = Object.entries(byChat)
    .filter(([, t]) => worthKeeping(t))
    .map(([k, t]) => [k, trimThread(t)] as const)
    .sort((a, b) => {
      const aTier = tier(a[1]);
      const bTier = tier(b[1]);
      if (aTier !== bTier) return bTier - aTier;
      const aTime = a[1].status === "trashed" ? (a[1].trashedAt ?? a[1].updatedAt) : a[1].updatedAt;
      const bTime = b[1].status === "trashed" ? (b[1].trashedAt ?? b[1].updatedAt) : b[1].updatedAt;
      return bTime - aTime; // luego los más recientes (o los trashed más nuevos)
    })
    .slice(0, MAX_CHATS);
  if (entries.length === 0) return null;

  const keptIds = new Set(entries.map(([, t]) => t.id));
  const prunedActive = Object.fromEntries(
    Object.entries(activeByProject).filter(([, id]) => keptIds.has(id)),
  );

  const payload: PersistedLab = {
    v: SCHEMA_VERSION,
    byChat: Object.fromEntries(entries),
    activeByProject: prunedActive,
    savedAt: now,
  };
  let raw = JSON.stringify(payload);
  // Todavía muy grande: se recorta más fuerte antes de rendirse. Perder los
  // mensajes viejos es mejor que no guardar nada.
  for (const cap of [30, 12, 4]) {
    if (raw.length <= MAX_BYTES) break;
    payload.byChat = Object.fromEntries(
      Object.entries(payload.byChat).map(([k, t]) => [k, trimThread(t, cap)]),
    );
    raw = JSON.stringify(payload);
  }
  return raw.length <= MAX_BYTES ? raw : null;
}

/** Un `docs`/`images` corrupto no puede colarse como válido: `UserBubble`
 *  hace `.map()` directo sin re-validar y no hay ErrorBoundary alrededor de
 *  la lista de mensajes — algo como un `docs` que resultara ser un string
 *  (pasaría cualquier chequeo laxo de "existe") tiraría el render del HILO
 *  ENTERO, no solo esa burbuja (hallazgo de la auditoría 2026-09-16). */
function isValidDocs(v: unknown): v is NonNullable<LabMessage["docs"]> {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every(
    (d) =>
      d &&
      typeof d === "object" &&
      typeof (d as { name?: unknown }).name === "string" &&
      ["done", "processing", "error"].includes((d as { status?: unknown }).status as string),
  );
}

function isValidImages(v: unknown): v is NonNullable<LabMessage["images"]> {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every(
    (i) =>
      i &&
      typeof i === "object" &&
      typeof (i as { url?: unknown }).url === "string" &&
      typeof (i as { name?: unknown }).name === "string",
  );
}

function isMessage(m: unknown): m is LabMessage {
  if (!m || typeof m !== "object") return false;
  const c = m as LabMessage;
  return (
    typeof c.id === "number" &&
    (c.role === "user" || c.role === "assistant") &&
    typeof c.content === "string" &&
    isValidDocs(c.docs) &&
    isValidImages(c.images)
  );
}

function isPendingTurn(p: unknown): p is PendingLabTurn {
  if (!p || typeof p !== "object") return false;
  const c = p as PendingLabTurn;
  return typeof c.id === "string" && c.id.length > 0 && typeof c.seq === "number";
}

/**
 * Lee lo guardado. Cualquier cosa rara —JSON roto, versión vieja, demasiado
 * viejo, forma inesperada— devuelve null: arrancar limpio es aceptable,
 * romperse al arrancar no.
 */
export function parseLab(raw: string | null, now: number): HydratedLab | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedLab;
    if (!data || data.v !== SCHEMA_VERSION || typeof data.byChat !== "object") return null;
    if (typeof data.savedAt === "number" && now - data.savedAt > MAX_AGE_MS) return null;
    const byChat: Record<string, LabThread> = {};
    for (const [k, t] of Object.entries(data.byChat)) {
      if (!t || typeof t.id !== "string" || !t.id) continue;
      if (!Array.isArray(t.messages) || !t.messages.every(isMessage)) continue;
      const status: "active" | "trashed" = t.status === "trashed" ? "trashed" : "active";
      // Un trashed necesita SIEMPRE una fecha de corte propia para que el
      // self-purge de abajo pueda hacer su cuenta. Antes, si `trashedAt` no
      // era un número (JSON viejo/corrupto con `status: "trashed"` pero sin
      // ese campo, o con un valor roto), quedaba `undefined` para siempre: la
      // condición de purga exige un número, así que NUNCA se cumplía y el
      // chat se quedaba en la papelera para la eternidad, sin fecha de
      // vencimiento — el peor de los dos mundos (ni activo ni purgable). Sin
      // fecha real que confiar, se lo trata como recién eliminado (arranca su
      // propio conteo de 30 días desde AHORA) en vez de inmortal.
      const trashedAt = status === "trashed" ? (typeof t.trashedAt === "number" ? t.trashedAt : now) : undefined;
      if (status === "trashed" && now - (trashedAt as number) > TRASH_RETENTION_MS) {
        continue;
      }
      byChat[k] = {
        id: t.id,
        ...(typeof t.title === "string" && t.title.trim() ? { title: t.title } : {}),
        updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : now,
        sdkSessionId: typeof t.sdkSessionId === "string" ? t.sdkSessionId : null,
        sessionKey: typeof t.sessionKey === "string" ? t.sessionKey : "",
        messages: t.messages,
        draft: typeof t.draft === "string" ? t.draft : "",
        model: typeof t.model === "string" ? t.model : null,
        pendingTurn: isPendingTurn(t.pendingTurn) ? t.pendingTurn : undefined,
        seenAt: typeof t.seenAt === "number" ? t.seenAt : undefined,
        ...(status === "trashed" ? { status, trashedAt } : {}),
      };
    }
    if (Object.keys(byChat).length === 0) return null;
    const activeByProject: Record<string, string> = {};
    if (data.activeByProject && typeof data.activeByProject === "object") {
      for (const [proj, id] of Object.entries(data.activeByProject)) {
        if (typeof id === "string" && id) activeByProject[proj] = id;
      }
    }
    return { byChat, activeByProject };
  } catch {
    return null;
  }
}

// ── Acceso a localStorage ──────────────────────────────────────────────
// Todo envuelto: en modo privado de Safari el simple acceso puede lanzar, y
// eso no puede tumbar el laboratorio.

export function loadLab(now = Date.now()): HydratedLab | null {
  try {
    return parseLab(localStorage.getItem(STORAGE_KEY), now);
  } catch {
    return null;
  }
}

export function saveLab(
  byChat: Record<string, LabThread>,
  activeByProject: Record<string, string>,
  now = Date.now(),
): void {
  try {
    const raw = serializeLab(byChat, activeByProject, now);
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Cuota llena o storage bloqueado: se sigue sin persistencia antes que
    // reventar el laboratorio.
  }
}
