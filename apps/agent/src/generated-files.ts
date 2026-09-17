/**
 * Archivos que el agente GENERA en el servidor (Write, o un script/Bash que
 * deja algo nuevo en el cwd del turno) — feature pedida por Jaime
 * (2026-09-17): "cuando se generen archivos nuevos... debe renderizarse una
 * card con el nombre y el icono de descargar e iniciar la descarga
 * automática".
 *
 * Mismo principio que `chat-attachments.ts` (adjuntos SUBIDOS por el
 * usuario): la ruta absoluta en disco NUNCA viaja al cliente — "regalar el
 * layout del servidor" es un riesgo innecesario cuando alcanza con un id
 * opaco. La diferencia con los adjuntos es que ACÁ el archivo no lo subimos
 * nosotros: ya existe en disco, en cualquier ruta dentro de
 * `ALLOWED_WRITE_ROOTS` (guardrails.ts) elegida por el propio agente. Así
 * que no hay "guardar" — solo un registro en memoria de
 * id → ruta absoluta + metadata, poblado por `session.ts` cuando detecta
 * que una tool creó un archivo nuevo.
 *
 * Vive en memoria (no en disco/Supabase) a propósito: es efímero por
 * diseño — un id vale mientras dura la sesión del proceso del agente; tras
 * un restart, un link viejo devuelve 404 en vez de arrastrar referencias a
 * archivos que ya no interesan. El archivo REAL sigue en disco (el registro
 * es solo el mapeo id→ruta, nunca borra nada).
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { GeneratedFile } from "@hermes/shared";
import { pathAllowed } from "./agent/guardrails.js";

interface RegistryEntry extends GeneratedFile {
  path: string;
  registeredAt: number;
}

const registry = new Map<string, RegistryEntry>();

/** Un id vale 24h — de sobra para que Jaime lo descargue el mismo día. */
const RETAIN_MS = 24 * 60 * 60 * 1000;

/** Techo de entradas vivas: un turno muy agéntico no puede dejar el mapa
 *  creciendo sin límite si Jaime nunca reinicia el proceso. Se descartan las
 *  más viejas primero (el archivo en disco no se toca, solo el registro). */
const MAX_ENTRIES = 500;

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
  ".ics": "text/calendar",
};

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function prune(): void {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, entry] of registry) {
    if (entry.registeredAt < cutoff) registry.delete(id);
  }
  if (registry.size > MAX_ENTRIES) {
    const sorted = [...registry.entries()].sort((a, b) => a[1].registeredAt - b[1].registeredAt);
    for (const [id] of sorted.slice(0, registry.size - MAX_ENTRIES)) registry.delete(id);
  }
}

/**
 * Registro en vuelo por ruta: dos llamadas CONCURRENTES a
 * `registerGeneratedFile` para la MISMA ruta nueva (ej. el `Write` de un
 * tool_use dispara el registro fire-and-forget mientras un `Bash` paralelo
 * también la detecta, ver session.ts) comparten la MISMA promesa en vez de
 * correr en paralelo — sin esto, el dedup por ruta de abajo no es atómico:
 * ambas llamadas pueden pasar el `await stat` y el loop de dedup ANTES de
 * que cualquiera termine de registrar, y cada una crea un id DISTINTO para
 * el mismo archivo (dos cards, dos auto-descargas del mismo PDF). Hallazgo
 * de auditoría adversaria (2026-09-17). La reserva es SÍNCRONA (antes de
 * cualquier `await`), así que no hay ventana donde dos llamadas la vean
 * vacía a la vez.
 */
const pendingRegistrations = new Map<string, Promise<GeneratedFile | null>>();

/**
 * Registra un archivo recién creado. Devuelve `null` (sin lanzar) si la
 * ruta no existe, no es un archivo regular, o cae fuera de
 * `ALLOWED_WRITE_ROOTS` — un turno agéntico no puede tumbarse por esto, y
 * la ruta ya pasó el guardrail de escritura para llegar hasta acá (Write) o
 * vive en el cwd permitido del turno (Bash), así que un rechazo acá es
 * defensa en profundidad, no el caso esperado.
 */
export async function registerGeneratedFile(rawPath: string): Promise<GeneratedFile | null> {
  const path = resolve(rawPath);
  const inFlight = pendingRegistrations.get(path);
  if (inFlight) return inFlight;
  const promise = registerGeneratedFileLocked(path);
  pendingRegistrations.set(path, promise);
  try {
    return await promise;
  } finally {
    pendingRegistrations.delete(path);
  }
}

async function registerGeneratedFileLocked(path: string): Promise<GeneratedFile | null> {
  if (!pathAllowed(path)) return null;
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return null;
  // Deduplicar por ruta: si el mismo archivo se re-detecta (ej. un Write
  // seguido de un Bash que lo toca de nuevo, en llamadas NO concurrentes —
  // el caso concurrente ya lo cubre `pendingRegistrations` arriba), no
  // queremos dos cards para el mismo archivo — se REFRESCA la entrada
  // existente (tamaño/fecha) y se devuelve el mismo id.
  for (const [id, entry] of registry) {
    if (entry.path === path) {
      entry.size = info.size;
      entry.registeredAt = Date.now();
      return { id, name: entry.name, mime: entry.mime, size: entry.size };
    }
  }
  const id = randomUUID();
  const name = basename(path);
  const mime = mimeFor(path);
  registry.set(id, { id, path, name, mime, size: info.size, registeredAt: Date.now() });
  // Podar DESPUÉS de insertar (no antes): así el tope queda en MAX_ENTRIES
  // de verdad tras cada alta, en vez de oscilar entre MAX_ENTRIES y
  // MAX_ENTRIES+1 para siempre (hallazgo de auditoría, impacto cosmético
  // pero gratis de corregir).
  prune();
  return { id, name, mime, size: info.size };
}

/** Ruta+mime de un id, o `null` si no existe/expiró/el archivo se borró. */
export async function resolveGeneratedFile(
  id: string,
): Promise<{ path: string; mime: string; name: string } | null> {
  const entry = registry.get(id);
  if (!entry) return null;
  const info = await stat(entry.path).catch(() => null);
  if (!info || !info.isFile()) {
    registry.delete(id);
    return null;
  }
  return { path: entry.path, mime: entry.mime, name: entry.name };
}

/** Solo para tests: vacía el registro entre casos. */
export function _resetGeneratedFilesForTests(): void {
  registry.clear();
}
