import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type {
  TaskState,
  Feature,
} from "@hermes/shared";
import { isEnabled, featureSummary } from "@hermes/shared";
import { env } from "./env.js";
import { EMB } from "./embeddings.js";
import { modelSummary } from "./agent/models.js";
import { budgetState } from "./agent/budget.js";
import { verifySupabaseToken } from "./auth.js";
import { activityHourly, emit, recentEvents, subscribe } from "./events.js";
import { getPresence, listPresence, pushPresence, selfBaseUrl } from "./presence.js";
import { readProjects, resolveProjectRoot } from "./vault/projects.js";
import { readProjectContext } from "./vault/project-context.js";
import { resolveVaultDoc } from "./vault/doc.js";
import { memoriesCount, recentMemories, saveMemory, hasSupabase } from "./memory.js";
import { searchKnowledge, knowledgeStats } from "./knowledge.js";
import { syncVaultKnowledge } from "./vault/knowledge-sync.js";
import { startSystemSampler, getSystemMetrics } from "./system.js";
import { registerJob, listJobs } from "./jobs.js";
import { updateCodeGraph } from "./code-graph.js";
import { getSdkSession, getTask, listTasks, startTask } from "./agent/session.js";
import {
  openClaudeTerminal,
  startClaudeRun,
  getClaudeRun,
  listClaudeRuns,
  killClaudeRun,
  subscribeClaudeRun,
  type ClaudeLine,
} from "./agent/claude-cli.js";
import { getDailyUsage } from "./usage.js";
import {
  getConversation,
  clearConversation,
  archiveConversation,
  listChats,
  restoreChat,
} from "./conversations.js";
import { listChatSessions, readChatSession, resolveChatCwd } from "./agent/chat-history.js";
import { chatTurns, type TurnEvent } from "./agent/chat-turns.js";
import { titleForChat } from "./agent/chat-title.js";
import {
  chatAttachmentPath,
  resolveChatAttachments,
  saveChatAttachment,
  MAX_ATTACHMENT_BYTES,
} from "./chat-attachments.js";
// El dictado del composer usaba el mismo STT que las juntas (Scribe → Whisper).
import { transcribe } from "./stt.js";
import {
  openInBrowser,
  listTabs,
  switchTab,
  browserCommand,
  ensureCdpChrome,
  BROWSER_COMMANDS,
  type BrowserCommand,
} from "./browser.js";
import { lightsCommand, LIGHT_ACTIONS, type LightAction } from "./lights.js";
import { listExecutions, getExecution } from "./tasks/executions.js";
import {
  listTasks as listTrackerTasks,
  createTask,
  getTask as getTrackerTask,
  updateTask,
  setTaskStatus,
  importVaultTasks,
  executeTask,
  continueTask,
  reconcileRunningTasks,
  trackerSummary,
} from "./tasks/store.js";
import { openInCursor } from "./agent/editor.js";
import {
  listClaudeSessions,
  getClaudeSession,
  deleteClaudeSession,
} from "./agent/claude-sessions.js";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { Readable } from "node:stream";
import { OWNER } from "./owner.js";
import {
  relojRapido,
  CENTINELA,
  CENTINELA_IMAGEN,
  CENTINELA_OTRA,
  ESTILO_ESCALADA,
} from "./watch/rapido.js";
import { buscarImagen } from "./watch/imagen.js";
import { capturarIdea, CENTINELA_IDEA } from "./watch/intenciones.js";
import { limitesDelPlan } from "./limits.js";
import * as relojTurnos from "./watch/turnos.js";
import * as relojVinculo from "./watch/active-link.js";
import { gistForAnswer } from "./agent/chat-gist.js";

const app = new Hono();
const startedAt = Date.now();

const expandHome = (p: string) => (p.startsWith("~") ? joinPath(homedir(), p.slice(1)) : p);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Orígenes permitidos: loopback, IPs privadas de la LAN, la malla de Tailscale
// y nombres mDNS (.local).
// Multi-máquina: el dashboard lo sirve UNA máquina y los browsers del resto de
// la red lo cargan desde http://192.168.x.x:31415 — con el allowlist viejo (solo
// localhost) el preflight moría y no había dashboard desde otro PC.
//
// MagicDNS usa DOS etiquetas: <host>.<tailnet>.ts.net. Con `[a-z0-9-]+` solo
// entraba UNA, así que `kreanding.tail7f2dbf.ts.net` —el origen real del
// dashboard— quedaba fuera y el navegador bloqueaba cada llamada al agente.
// Se veía como "Desconectado" y "Load failed" con TODO respondiendo por curl,
// porque curl no manda Origin. De ahí el `(?:[a-z0-9-]+\.)+`.
//
// 100.64.0.0/10 es el rango CGNAT que usa Tailscale. Faltaba: el allowlist ya
// aceptaba los nombres MagicDNS (*.ts.net) pero NO las IPs crudas de la malla,
// así que abrir el dashboard en http://100.x.x.x:31415 cargaba la página y
// luego mostraba "Desconectado" — el preflight al agente moría en CORS. El
// segundo octeto va de 64 a 127.
const LAN_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|(?:[a-z0-9-]+\.)+(?:local|ts\.net))(?::\d+)?$/i;

// Private Network Access: Chrome exige que un preflight que va de una IP
// privada a loopback lo autorice explícitamente. Se responde ANTES del cors
// (que corta el OPTIONS) y se escribe sobre c.res, igual que hace el propio
// middleware de Hono.
app.use("*", async (c, next) => {
  await next();
  if (c.req.header("Access-Control-Request-Private-Network")) {
    c.res.headers.set("Access-Control-Allow-Private-Network", "true");
  }
});

app.use(
  "*",
  cors({
    origin: (origin) => (!origin || LAN_ORIGIN.test(origin) ? origin : ""),
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Hermes-Session-Id",
      "X-Hermes-Project",
      "X-Hermes-Resume",
    ],
  }),
);

// Access log a stdout (launchd lo captura en ~/.hermes-os/logs/agent.log).
// Registra mutaciones (POST/PUT/DELETE) y cualquier error (4xx/5xx); los GET
// 2xx de polling se omiten para no inundar el log. Clave para forense de
// uploads del móvil: sin esto, un "Network request failed" del teléfono no
// deja rastro de si el request llegó o no.
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  const method = c.req.method;
  const status = c.res.status;
  if (method === "OPTIONS" || c.req.path === "/events") return;
  if ((method === "GET" || method === "HEAD") && status < 400) return;
  const len = c.req.header("content-length");
  const size = len ? ` ${(Number(len) / 1024 / 1024).toFixed(1)}MB` : "";
  console.log(
    `[http] ${new Date().toISOString()} ${method} ${c.req.path} → ${status} ${Date.now() - t0}ms${size}`,
  );
});

// Bearer opcional: solo se exige si HERMES_API_KEY está configurada (multi-Mac
// vía Tailscale). Los SSE usan EventSource, que no puede mandar headers → en
// rutas GET se acepta también el token como query ?key=. Además del API key
// estático se acepta un access token de Supabase Auth (login email+contraseña
// de la app móvil, que llega por el túnel cloudflared).
app.use("*", async (c, next) => {
  if (env.HERMES_API_KEY && c.req.path !== "/health") {
    const auth = c.req.header("Authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const queryKey = c.req.method === "GET" ? (c.req.query("key") ?? "") : "";
    const staticOk = bearer === env.HERMES_API_KEY || queryKey === env.HERMES_API_KEY;
    if (!staticOk) {
      const userId = await verifySupabaseToken(bearer || queryKey);
      if (!userId) return c.json({ error: "unauthorized" }, 401);
    }
  }
  await next();
});

// ── Features apagadas ─────────────────────────────────────────────────
// Un solo guardia por PREFIJO en vez de tocar cada una de las ~80 rutas: son
// planas y están repartidas por todo el archivo, así que gatearlas de a una
// se desincronizaría a la primera ruta nueva. El código de la feature queda
// intacto — solo deja de ser alcanzable.
const FEATURE_PREFIX: [string, Feature][] = [
];

app.use("*", async (c, next) => {
  const path = c.req.path;
  const hit = FEATURE_PREFIX.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  if (hit && !isEnabled(hit[1])) {
    // 404 con motivo, no 500 ni un silencio: quien llama debe poder distinguir
    // "no existe aquí" de "se rompió".
    return c.json({ error: `feature "${hit[1]}" desactivada en ${env.MACHINE_NAME}` }, 404);
  }
  await next();
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    machine: env.MACHINE_NAME,
    // El selector de máquina sondea /health (sin auth) para saber a quién le
    // está hablando: sin el nombre, dos agentes de la LAN son indistinguibles.
    baseUrl: selfBaseUrl(),
    uptime: (Date.now() - startedAt) / 1000,
  }),
);

// ── Contrato Hermes: OpenAI-compatible SSE ─────────────────────────────
app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>();
  const clientSession = c.req.header("X-Hermes-Session-Id") ?? "default";
  const focusProject = c.req.header("X-Hermes-Project") || undefined;
  // Resume explícito por tab (uuid de sesión SDK, validado); sin él cae al
  // mapeo legado clientSession → sdkSessionId (voz / clientes viejos).
  const resumeHeader = c.req.header("X-Hermes-Resume");
  const messages = body.messages ?? [];
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!lastUser) return c.json({ error: "no user message" }, 400);

  // "new" = sesión fresca (tab nuevo); uuid = resume de esa sesión; sin
  // header = mapeo legado (clientes viejos / voz).
  const resume =
    resumeHeader === "new"
      ? undefined
      : resumeHeader && UUID_RE.test(resumeHeader)
        ? resumeHeader
        : await getSdkSession(clientSession);
  // Con proyecto en foco la sesión corre EN su repo (ruta_local): el
  // transcript cae en ~/.claude/projects/<repo> y Cursor ve el mismo chat.
  const cwd = await resolveChatCwd(focusProject);
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: string | null, finish: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: "hermes",
    choices: [
      {
        index: 0,
        delta: delta === null ? {} : { content: delta },
        finish_reason: finish,
      },
    ],
  });

  // El turno corre en el MOTOR (agent/chat-turns.ts), no dentro de este
  // request: si el cliente se cae a mitad —iOS congelando la pestaña— el
  // trabajo sigue, se persiste y se puede recuperar por `/chat/turns/:id`.
  // Este endpoint conserva el contrato OpenAI para la voz y el móvil.
  const turn = chatTurns.start({
    prompt: lastUser,
    sessionKey: clientSession,
    project: focusProject,
    cwd,
    resumeSessionId: resume,
  });

  return streamSSE(c, async (stream) => {
    // Serializamos las escrituras para conservar el orden de los deltas.
    let queue: Promise<unknown> = Promise.resolve();
    const send = (data: unknown) => {
      // Mismo `.catch` que en /chat/turns/:id/stream: escribirle a un cliente
      // que ya se fue no puede convertirse en un unhandled rejection que
      // tumbe el proceso entero (y con él, los turnos de todos los demás).
      queue = queue
        .then(() =>
          stream.writeSSE({ data: typeof data === "string" ? data : JSON.stringify(data) }),
        )
        .catch(() => {});
      return queue;
    };
    // El id del turno viaja primero: con él, un cliente que se cayó puede
    // recuperar la respuesta después en vez de perderla.
    await send({ hermes: { turn_id: turn.id } });

    await pipeTurn(turn.id, 0, {
      onEvent: (e) => {
        if (e.kind === "delta" && e.text) void send(chunk(e.text));
        else if (e.kind === "session" && e.sessionId)
          void send({ hermes: { session_id: e.sessionId } });
        else if (e.kind === "tool" && e.tool) void send({ hermes: { tool: e.tool } });
        else if (e.kind === "retry")
          void send({ hermes: { retry: { attempt: e.attempt ?? 0, reason: e.text ?? "" } } });
      },
      // Cerrar el socket NO cancela el turno: solo deja de escucharlo.
      signal: c.req.raw.signal,
    });

    await send(chunk(null, "stop"));
    await send("[DONE]");
    await queue;
  });
});

/**
 * Puente motor → SSE, común a los dos endpoints de streaming.
 *
 * Se suscribe y toma el snapshot en el MISMO tick (sin await entre medias) para
 * que ningún evento caiga entre el replay y la suscripción. Resuelve cuando el
 * turno cierra o cuando el cliente se va; en el segundo caso el turno SIGUE.
 */
async function pipeTurn(
  turnId: string,
  from: number,
  opts: {
    onEvent: (e: TurnEvent) => void;
    signal: AbortSignal;
    onSnapshot?: (snap: NonNullable<ReturnType<typeof chatTurns.snapshot>>) => void;
  },
): Promise<void> {
  const terminal = new Set(["done", "error", "stopped"]);
  await new Promise<void>((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      unsub?.();
      resolve();
    };
    const attached = chatTurns.attach(turnId, from, (e) => {
      opts.onEvent(e);
      if (terminal.has(e.kind)) settle();
    });
    if (!attached) return settle();
    unsub = attached.unsubscribe;
    opts.onSnapshot?.(attached.snapshot);
    for (const e of attached.snapshot.events) opts.onEvent(e);
    // Ya estaba cerrado antes de suscribirnos (el caso de quien vuelve tarde).
    if (attached.snapshot.status !== "running") return settle();
    if (attached.snapshot.events.some((e) => terminal.has(e.kind))) return settle();
    opts.signal.addEventListener("abort", settle);
  });
}

// ── Turnos del chat: arrancar, re-adjuntarse, detener ──────────────────
// El cliente manda el turno y se lo puede olvidar. Al volver —otro día, otro
// dispositivo, la pantalla desbloqueada— pide el snapshot o se re-engancha al
// stream desde su cursor. Nada de esto depende de que la pestaña siga viva.

/**
 * Sube UNA imagen y devuelve su id. Se sube antes de enviar el mensaje (al
 * pegar en el input), no junto con él: así el chip aparece al instante en el
 * composer y el envío del turno sigue siendo un JSON pequeño con ids.
 */
app.post(
  "/chat/attachments",
  bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.["image"];
    if (!(file instanceof File)) return c.json({ error: "campo 'image' requerido" }, 400);
    const { attachment, error } = await saveChatAttachment({
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      name: file.name,
    });
    if (error || !attachment) return c.json({ error: error ?? "no se pudo guardar" }, 400);
    // La ruta en disco NO sale al cliente: el navegador no la necesita (pide el
    // binario por id) y publicarla es regalar el layout del servidor.
    const { path: _path, ...safe } = attachment;
    return c.json(safe);
  },
);

/**
 * Devuelve el binario para la miniatura del chat. Mismo patrón que el media de
 * Estudio: stream desde disco, Bearer por el middleware global. El id se
 * valida como UUID dentro de chatAttachmentPath — de ahí que no haya que
 * sanear nada aquí.
 */
app.get("/chat/attachments/:id", async (c) => {
  const found = chatAttachmentPath(c.req.param("id"));
  if (!found) return c.json({ error: "adjunto no encontrado" }, 404);
  const { size } = await stat(found.path);
  return new Response(Readable.toWeb(createReadStream(found.path)) as ReadableStream, {
    headers: {
      "Content-Type": found.mime,
      "Content-Length": String(size),
      // Inmutable de verdad: el id es un uuid y el archivo nunca se reescribe.
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
});

/**
 * Última imagen enseñada en el reloj, para poder pasar a la siguiente.
 *
 * Vive en memoria del proceso y no en la base de datos a propósito: "esa no,
 * otra" solo tiene sentido en los segundos siguientes, y persistirlo obligaría
 * a decidir cuándo caduca.
 */
let ultimaImagen: { q: string; indice: number } | null = null;

/**
 * Canal del reloj: DOS velocidades.
 *
 * Primero pregunta a la sesión persistente (sin tools, proceso ya vivo): eso
 * contesta en menos de un segundo y cubre la charla, que es la mayoría de lo
 * que se dicta a un reloj. Si la pregunta necesita el sistema de verdad, el
 * modelo devuelve el centinela CONSULTAR y ahí SÍ se paga un turno completo,
 * con tools, emitiendo sus pasos.
 *
 * La premisa es la conversación híper rápida: el camino lento se paga solo
 * cuando hace falta, no por si acaso.
 */
/**
 * Consumo del plan, para el pie del chat del reloj y del iPhone.
 *
 * La web lo lee ella misma con su propia ruta de Next; esos clientes no
 * pueden, así que lo expone el agente. Cachea 60s: lo pide un cliente por
 * turno y el endpoint de origen es de Anthropic, no nuestro.
 */
/**
 * Re-enganche del turno del reloj.
 *
 * `?from=` es el cursor: se devuelve solo lo que el reloj no vio. El texto
 * íntegro va aparte para poder repintar sin concatenar si hiciera falta.
 */
app.get("/watch/turns/:id", (c) => {
  const snap = relojTurnos.snapshot(c.req.param("id"), Number(c.req.query("from") ?? 0) || 0);
  if (!snap) return c.json({ error: "turno no encontrado" }, 404);
  return c.json(snap);
});

/** Igual, pero en streaming: sirve lo pendiente y sigue hasta que cierre. */
app.get("/watch/turns/:id/stream", (c) => {
  const id = c.req.param("id");
  if (!relojTurnos.existe(id)) return c.json({ error: "turno no encontrado" }, 404);
  const desde = Number(c.req.query("from") ?? 0) || 0;

  return streamSSE(c, async (stream) => {
    await new Promise<void>((resolve) => {
      const soltar = relojTurnos.seguir(id, desde, (e) => {
        void stream.writeSSE({ event: e.tipo, data: JSON.stringify(e.datos) });
        if (e.tipo === "fin" || e.tipo === "error") {
          soltar?.();
          resolve();
        }
      });
      if (!soltar) return resolve();
      c.req.raw.signal.addEventListener("abort", () => {
        soltar();
        resolve();
      });
    });
  });
});

app.get("/limits", async (c) => c.json(await limitesDelPlan()));

app.post("/watch/ask", async (c) => {
  const b = await c.req.json<{ message?: string }>().catch(() => ({}) as Record<string, never>);
  const message = b.message?.trim();
  if (!message) return c.json({ error: "message requerido" }, 400);

  const turnoId = randomUUID();
  relojTurnos.crear(turnoId);

  // EL TRABAJO CORRE SUELTO, no dentro del stream.
  //
  // Antes iba dentro del handler del SSE y `pipeTurn` recibía
  // `c.req.raw.signal`: al desconectarse el reloj —o sea, al bajar la muñeca—
  // la señal abortaba y el turno terminaba a medias. Guardar los eventos no
  // servía de nada si el trabajo moría con el socket. Ahora el turno vive por
  // su cuenta y el stream solo RELATA lo que va pasando; irse solo quita un
  // oyente.
  void trabajarReloj(turnoId, message);

  return streamSSE(c, async (stream) => {
    // Lo primero, el id: el reloj lo guarda y con él puede volver.
    await stream.writeSSE({ event: "turno", data: JSON.stringify({ id: turnoId }) });

    await new Promise<void>((resolve) => {
      const soltar = relojTurnos.seguir(turnoId, 0, (e) => {
        void stream.writeSSE({ event: e.tipo, data: JSON.stringify(e.datos) });
        if (e.tipo === "fin" || e.tipo === "error") {
          soltar?.();
          resolve();
        }
      });
      if (!soltar) return resolve();
      c.req.raw.signal.addEventListener("abort", () => {
        soltar();
        resolve();
      });
    });
  });
});

/**
 * El turno del reloj, de principio a fin, emitiendo a su registro.
 *
 * No recibe el `Context` de Hono a propósito: nada de aquí debe poder morir
 * porque el cliente se fue. Es lo que hace que bajar la muñeca a mitad de una
 * respuesta ya no la pierda.
 */
async function trabajarReloj(turnoId: string, message: string): Promise<void> {
  const emitir = (tipo: string, datos: unknown = {}) =>
    relojTurnos.emitir(turnoId, tipo, datos);

  // Latido desde el byte cero: si la sesión rápida se atasca, sin esto el
  // stream se queda mudo y no hay forma de distinguir "pensando" de "colgado".
  let latido: ReturnType<typeof setInterval> | null =
    setInterval(() => emitir("latido"), 3000);
  const pararLatido = () => {
    if (latido) clearInterval(latido);
    latido = null;
  };

  try {
    const rapida = await relojRapido.preguntar(message, (t) => emitir("delta", { text: t }));
    const limpia = rapida.trim();

    // Capturar una idea es UNA escritura: escalar costaría ~28 s por algo que
    // tarda lo que tarde la base de datos.
    if (limpia.toUpperCase().startsWith(CENTINELA_IDEA)) {
      const idea = limpia.slice(CENTINELA_IDEA.length).trim();
      const ok = await capturarIdea(idea);
      emitir("delta", { text: ok ? "Apuntado." : "No pude guardarlo." });
      if (ok) relojRapido.anotar(`Se apuntó esta idea del usuario: ${idea}`);
      return;
    }

    if (limpia.toUpperCase().startsWith(CENTINELA_IMAGEN)) {
      const q = limpia.slice(CENTINELA_IMAGEN.length).trim();
      const url = await buscarImagen(q, 0);
      if (url) {
        ultimaImagen = { q, indice: 0 };
        emitir("imagen", { url, q });
      } else {
        emitir("delta", { text: `No encontré una imagen de ${q}.` });
      }
      return;
    }

    // "Esa no, otra": la siguiente de la MISMA búsqueda.
    if (limpia.toUpperCase() === CENTINELA_OTRA) {
      if (!ultimaImagen) {
        emitir("delta", { text: "No sé de qué imagen hablas." });
      } else {
        const siguiente = ultimaImagen.indice + 1;
        const url = await buscarImagen(ultimaImagen.q, siguiente);
        if (url) {
          ultimaImagen = { q: ultimaImagen.q, indice: siguiente };
          emitir("imagen", { url, q: ultimaImagen.q });
        } else {
          emitir("delta", { text: "No hay más imágenes." });
        }
      }
      return;
    }

    if (limpia.toUpperCase() !== CENTINELA) return;

    // Escalada: la pregunta necesita mirar el sistema.
    emitir("escala");
    const turno = chatTurns.start({
      prompt: `${ESTILO_ESCALADA}\n\n${message}`,
      sessionKey: "reloj",
      maxTier: "trivial",
      magro: true,
      cwd: await resolveChatCwd(undefined),
    });

    // Sin `signal`: este turno NO se cancela porque el reloj se haya ido.
    // `attach` devuelve el snapshot de lo ya ocurrido más la suscripción, y
    // hay que repartir PRIMERO el snapshot: entre el start y el attach ya
    // pueden haber pasado eventos.
    await new Promise<void>((resolve) => {
      // `attach` puede devolver undefined si el turno ya no existe. Se
      // declara antes para que el reparto pueda soltarse a sí mismo.
      let attached: ReturnType<typeof chatTurns.attach> | undefined;
      const reparte = (e: TurnEvent) => {
        const x = e as unknown as {
          kind?: string;
          text?: string;
          tool?: { name?: string; target?: string };
        };
        if (x.kind === "delta" && x.text) emitir("delta", { text: x.text });
        else if (x.kind === "tool" && x.tool?.name) {
          emitir("paso", { name: x.tool.name, target: x.tool.target ?? "" });
        }
        if (x.kind === "done" || x.kind === "error" || x.kind === "stopped") {
          attached?.unsubscribe();
          resolve();
        }
      };
      attached = chatTurns.attach(turno.id, 0, reparte);
      if (!attached) return resolve();
      for (const e of attached.snapshot.events) reparte(e);
      if (attached.snapshot.status !== "running") {
        attached.unsubscribe();
        resolve();
      }
    });

    const cerrado = chatTurns.snapshot(turno.id, 0);
    if (cerrado?.text) {
      relojRapido.anotar(
        `El usuario preguntó "${message}" y se le respondió: ${cerrado.text.slice(0, 400)}`,
      );
    }
  } catch (err) {
    console.error("[reloj] turno falló:", err);
    emitir("delta", { text: "Algo falló de mi lado." });
  } finally {
    pararLatido();
    emitir("fin", {});
  }
}

app.post("/chat/turns", async (c) => {
  const b = await c.req
    .json<{
      message?: string;
      session_key?: string;
      project?: string;
      resume?: string;
      attachments?: string[];
    }>()
    .catch(() => ({}) as Record<string, never>);
  const message = b.message?.trim();
  // Ids → rutas absolutas, descartando lo que ya no exista en disco.
  const attachments = resolveChatAttachments(b.attachments);
  // Con imagen y sin texto el turno es válido: pegar un pantallazo y darle
  // enviar es una pregunta completa ("¿qué ves acá?"). El preámbulo de
  // chat-attachments ya le dice al modelo qué hacer con ella.
  if (!message && attachments.length === 0) return c.json({ error: "message requerido" }, 400);
  const sessionKey = b.session_key || c.req.header("X-Hermes-Session-Id") || "default";
  const project = b.project || c.req.header("X-Hermes-Project") || undefined;
  const resume =
    b.resume && UUID_RE.test(b.resume) ? b.resume : await getSdkSession(sessionKey);
  // El canal del reloj va con techo `light` (haiku, sin effort). Ahí las
  // respuestas son de UNA frase y lo único que se nota es el tiempo hasta la
  // primera palabra; sonnet con effort medium tardaba tanto que el turno se
  // veía colgado en la muñeca. Es un TECHO, no un modelo fijo: el perfil de
  // bajo consumo puede seguir bajándolo, nunca subirlo.
  const esReloj = sessionKey === "reloj";
  const turn = chatTurns.start({
    prompt: message || "¿Qué ves en esta imagen?",
    ...(esReloj ? { maxTier: "trivial" as const, magro: true } : {}),
    attachments,
    sessionKey,
    project,
    cwd: await resolveChatCwd(project),
    resumeSessionId: resume,
  });
  return c.json({ turn_id: turn.id, status: turn.status, seq: 0 });
});

/**
 * Nombre corto (2-3 palabras) para un chat, a partir de su primer mensaje.
 * Un pase de haiku, sin tools — ver agent/chat-title.ts. Devuelve `title: ""`
 * si el modelo falla: el cliente cae a su heurística y no se rompe nada.
 */
app.post("/chat/title", async (c) => {
  const b = await c.req.json<{ message?: string }>().catch(() => ({}) as Record<string, never>);
  const message = (b.message ?? "").trim();
  if (!message) return c.json({ error: "message requerido" }, 400);
  return c.json({ title: await titleForChat(message) });
});

/**
 * Frase de una línea para la pantalla del reloj, a partir de un texto largo
 * (la respuesta ya terminada de un turno). Ver agent/chat-gist.ts.
 */
app.post("/chat/gist", async (c) => {
  const b = await c.req.json<{ text?: string }>().catch(() => ({}) as Record<string, never>);
  const text = (b.text ?? "").trim();
  if (!text) return c.json({ error: "text requerido" }, 400);
  return c.json({ gist: await gistForAnswer(text) });
});

/**
 * "Chat vinculado al reloj" — ver watch/active-link.ts.
 *
 * POST lo llama quien está en un chat del Laboratorio (web o iPhone) y
 * quiere que el reloj lo siga: manda el turno que arrancó y un título corto
 * para la pantalla de "vincular". GET lo llama el reloj para saber a qué
 * turno engancharse — sigue `/chat/turns/:id/stream` con el MISMO contrato
 * que ya usan el dashboard y la app de iPhone, no hace falta nada nuevo ahí.
 */
app.post("/watch/link", async (c) => {
  const b = await c.req
    .json<{ turn_id?: string; title?: string }>()
    .catch(() => ({}) as Record<string, never>);
  const turnId = b.turn_id?.trim();
  if (!turnId) return c.json({ error: "turn_id requerido" }, 400);
  relojVinculo.vincular(turnId, b.title ?? "");
  return c.json({ ok: true });
});

app.delete("/watch/link", (c) => {
  relojVinculo.desvincular();
  return c.json({ ok: true });
});

app.get("/watch/link", (c) => {
  const v = relojVinculo.activo();
  if (!v) return c.json({ linked: false });
  return c.json({ linked: true, turn_id: v.turnId, title: v.title });
});

/** Estado + lo que falte desde `from`. Es lo que pide quien vuelve. */
app.get("/chat/turns/:id", (c) => {
  const from = Number(c.req.query("from") ?? 0) || 0;
  const snap = chatTurns.snapshot(c.req.param("id"), from);
  if (!snap) return c.json({ error: "turno no encontrado" }, 404);
  return c.json(snap);
});

/** Turnos recientes de un tab: permite re-engancharse sin recordar el id. */
app.get("/chat/turns", (c) => {
  const session = c.req.query("session");
  if (!session) return c.json({ error: "session requerido" }, 400);
  return c.json(chatTurns.listBySession(session, Number(c.req.query("limit") ?? 5) || 5));
});

app.post("/chat/turns/:id/stop", (c) => {
  const stopped = chatTurns.stop(c.req.param("id"));
  return c.json({ ok: stopped });
});

/**
 * Stream del turno desde `from`. Cerrar esta conexión NO cancela el turno —
 * para eso está `/stop`. Reconectar con el último `seq` recibido continúa
 * exactamente donde se quedó.
 */
app.get("/chat/turns/:id/stream", (c) => {
  const id = c.req.param("id");
  const from = Number(c.req.query("from") ?? 0) || 0;
  if (!chatTurns.get(id)) return c.json({ error: "turno no encontrado" }, 404);

  return streamSSE(c, async (stream) => {
    let queue: Promise<unknown> = Promise.resolve();
    const send = (event: string, data: unknown) => {
      // El `.catch` no es cosmética: si el cliente ya se fue (iPhone bloqueado,
      // WiFi caído), `writeSSE` rechaza y sin esto quedaría un unhandled
      // rejection que en Node tumba el PROCESO — o sea, un cliente que se va
      // mataría los turnos de todos los demás. Escribir a un socket muerto no
      // es un error del turno: el turno sigue, esta conexión no.
      queue = queue
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => {});
      return queue;
    };
    // Latido cada 15 s. Sin él, un turno que pasa dos minutos dentro de una
    // sola herramienta (un subagente, un build) no manda un solo byte, y ni el
    // navegador ni ningún proxy de por medio pueden distinguir "trabajando" de
    // "conexión muerta": iOS congela la pestaña, el socket queda medio abierto
    // y el EventSource nunca dispara `onerror` — la respuesta parecía perdida
    // aunque el servidor la estuviera escribiendo. Con el latido, el cliente
    // sabe medir el silencio y reengancharse (ver STALE_MS en lib/chat-turns).
    const beat = setInterval(() => void send("ping", { t: Date.now() }), 15_000);
    try {
      await pipeTurn(id, from, {
        // `state` primero: el cliente sabe de una si el turno ya terminó
        // mientras no estaba, y con `text` puede repintar sin depender del
        // buffer de eventos (que sí se recorta).
        onSnapshot: (snap) =>
          void send("state", {
            status: snap.status,
            text: snap.text,
            steps: snap.steps,
            seq: snap.seq,
            truncated: snap.truncated,
            attempts: snap.attempts,
            sdkSessionId: snap.sdkSessionId,
            model: snap.model,
            effort: snap.effort,
            error: snap.error,
          }),
        onEvent: (e) => void send("turn", e),
        signal: c.req.raw.signal,
      });
    } finally {
      clearInterval(beat);
    }
    const final = chatTurns.snapshot(id);
    await send("end", { status: final?.status ?? "done", seq: final?.seq ?? 0 });
    await queue;
  });
});

// ── Historial de conversaciones por proyecto ──────────────────────────
app.get("/conversations/:project", async (c) => {
  const project = c.req.param("project") || "general";
  const messages = await getConversation(project);
  return c.json(messages.slice(-200)); // últimos 200 mensajes
});

app.delete("/conversations/:project", async (c) => {
  const project = c.req.param("project") || "general";
  await clearConversation(project);
  return c.json({ ok: true });
});

// ── Sesiones de la consola: DIRECTO de ~/.claude/projects ─────────────
// La misma fuente que ve `claude` abierto en el repo del proyecto (Cursor).
app.get("/chat/sessions", async (c) => {
  const cwd = await resolveChatCwd(c.req.query("project") || undefined);
  return c.json(await listChatSessions(cwd));
});

app.get("/chat/sessions/:id", async (c) => {
  const cwd = await resolveChatCwd(c.req.query("project") || undefined);
  const detail = await readChatSession(cwd, c.req.param("id"));
  if (!detail) return c.json({ error: "sesión no encontrada" }, 404);
  return c.json(detail);
});

// Historial de chats: lista de archivados, "nuevo chat" (archiva el activo)
// y restaurar uno viejo como conversación activa.
app.get("/conversations/:project/chats", async (c) =>
  c.json(await listChats(c.req.param("project") || "general")),
);

app.post("/conversations/:project/chats/new", async (c) => {
  await archiveConversation(c.req.param("project") || "general");
  return c.json({ ok: true });
});

app.post("/conversations/:project/chats/:id/restore", async (c) => {
  const msgs = await restoreChat(c.req.param("project") || "general", c.req.param("id"));
  if (!msgs) return c.json({ error: "chat no encontrado" }, 404);
  return c.json(msgs.slice(-200));
});

// ── Tareas async (voz → run_task / check_task) ─────────────────────────
app.post("/tasks", async (c) => {
  const { prompt } = await c.req.json<{ prompt?: string }>();
  if (!prompt) return c.json({ error: "prompt requerido" }, 400);
  const task = startTask(prompt);
  return c.json({ task_id: task.id, status: task.status });
});

app.get("/tasks", (c) => c.json(listTasks().slice(0, 20)));

app.get("/tasks/:id", (c) => {
  const task = getTask(c.req.param("id"));
  if (!task) return c.json({ error: "task no encontrada" }, 404);
  return c.json(task);
});

// ── Dictado del composer (voz → texto con puntuación) ──────────────────
// El micrófono de los inputs (Laboratorio, consola) usa la Web Speech API del
// navegador para el texto EN VIVO, pero ese motor casi no puntúa en español.
// Al soltar el botón, el clip grabado se manda aquí y se re-transcribe con el
// mismo Scribe/Whisper que las juntas, que SÍ devuelve comas y puntos.
//
// Es un clip corto (una frase o un párrafo dictado), no una junta: no hay job
// async ni persistencia — se transcribe y se devuelve el texto en la misma
// respuesta, porque el composer lo necesita para pintarlo en el input.
app.post(
  "/dictado/transcribir",
  bodyLimit({ maxSize: 25 * 1024 * 1024 }), // 25 MB: el techo de Whisper (Scribe no tiene límite de tamaño)
  async (c) => {
    const body = await c.req.parseBody();
    const audio = body.audio;
    if (!audio || typeof audio === "string") return c.json({ error: "falta `audio`" }, 400);
    // Un clip de menos de ~1 KB es silencio o un toque accidental del botón:
    // no vale gastar una llamada de STT en él.
    if (audio.size < 1024) return c.json({ text: "", provider: null, empty: true });
    // Sin ELEVENLABS_API_KEY ni OPENAI_API_KEY, `transcribe()` iba a fallar
    // GARANTIZADO en cada dictado — y el error mencionaba "ElevenLabs", que es
    // justo el ruido que aparecía en el chat mientras Samu hablaba. El cliente
    // ya cae solo al texto de la Web Speech API cuando esto responde `empty`
    // (ver `finish()` en useVoiceDictation.ts), así que no repuntuar aquí no
    // pierde el dictado: solo evita gastar una llamada condenada a fallar y
    // el `console.error` que la acompañaba.
    if (!env.ELEVENLABS_API_KEY && !env.OPENAI_API_KEY) {
      return c.json({ text: "", provider: null, empty: true });
    }
    try {
      const result = await transcribe(audio);
      return c.json({
        text: result.text.trim(),
        provider: result.provider,
        language: result.language ?? null,
      });
    } catch (err) {
      // El consumidor se queda con el texto de la Web Speech API como
      // respaldo, así que esto degrada la puntuación pero nunca pierde el
      // dictado. Por eso es 502 con detalle y no un error opaco.
      console.error("[dictado] transcripción falló:", err);
      return c.json({ error: String(err).slice(0, 300) }, 502);
    }
  },
);


// ── Control del navegador por voz (Chrome real vía AppleScript) ────────
// Respuestas SIEMPRE 200 con { ok, error }: el client tool de la voz relata
// el error tal cual (p.ej. el permiso de "Allow JavaScript from Apple Events").

app.post("/browser/open", async (c) => {
  const body = await c.req.json<{ target?: string }>().catch(() => ({}) as { target?: string });
  const target = body.target?.trim();
  if (!target) return c.json({ ok: false, error: "target requerido" }, 400);
  const res = await openInBrowser(target);
  if (res.ok) emit({ kind: "browser", detail: `abrió ${res.label}` });
  return c.json(res);
});

app.get("/browser/tabs", async (c) => c.json(await listTabs()));

app.post("/browser/tab", async (c) => {
  const body = await c.req.json<{ query?: string }>().catch(() => ({}) as { query?: string });
  const query = body.query?.trim();
  if (!query) return c.json({ ok: false, error: "query requerido" }, 400);
  const res = await switchTab(query);
  if (res.ok) emit({ kind: "browser", detail: `pestaña → ${res.title.slice(0, 60)}` });
  return c.json(res);
});

// Navegación PROFUNDA en lenguaje natural: un agente SDK con las tools de
// chrome-devtools-mcp maneja el Chrome CDP dedicado (visible). Async como
// /tasks: task_id inmediato, la voz reporta con check_task.
app.post("/browser/navigate", async (c) => {
  if (!env.BROWSER_AGENT_ENABLED) {
    return c.json({ ok: false, error: "navegación agéntica desactivada (HERMES_BROWSER_AGENT=off)" });
  }
  const body = await c.req
    .json<{ instruction?: string }>()
    .catch(() => ({}) as { instruction?: string });
  const instruction = body.instruction?.trim();
  if (!instruction) return c.json({ ok: false, error: "instruction requerida" }, 400);
  // Pre-lanza el Chrome dedicado: la ventana aparece YA (feedback visual)
  // mientras arranca la sesión SDK; el guardrail lo re-garantiza por tool.
  void ensureCdpChrome();
  const task = startTask(
    `Eres las manos de ${OWNER} en su navegador. Usa las tools del navegador (mcp__chrome-devtools__*) para cumplir EXACTAMENTE esta instrucción dicha por voz: "${instruction}".

Método: navega a la URL que corresponda; toma un snapshot para VER la página y sus elementos (uids); interactúa (click, llenar, scroll) usando esos uids; verifica con otro snapshot tras cada acción importante. El Chrome es REAL y ${OWNER} lo está VIENDO en pantalla: no cierres pestañas que no abriste tú. Si un sitio pide iniciar sesión, NO intentes credenciales — reporta que ${OWNER} debe iniciar sesión una vez en el perfil "Hermes" y ahí queda guardada. Termina SIEMPRE con un resumen de una o dos frases aptas para voz: dónde quedaste y qué encontraste.`,
  );
  emit({ kind: "browser", detail: `navegando: ${instruction.slice(0, 120)}` });
  return c.json({ ok: true, task_id: task.id });
});

app.post("/browser/command", async (c) => {
  const body = await c.req.json<{ command?: string }>().catch(() => ({}) as { command?: string });
  const command = body.command?.trim() as BrowserCommand | undefined;
  if (!command || !BROWSER_COMMANDS.includes(command)) {
    return c.json({ ok: false, error: `command inválido (${BROWSER_COMMANDS.join("|")})` }, 400);
  }
  const res = await browserCommand(command);
  if (res.ok) emit({ kind: "browser", detail: `navegador · ${command}` });
  return c.json(res);
});

// ── Luces del cuarto (tira Kasa KL400L5 "luz led" en la LAN) ───────────
// Mismo contrato que el navegador: 200 con { ok, detail | error } para que
// la voz relate el resultado (o el error) tal cual.

app.post("/lights/command", async (c) => {
  const body = await c.req
    .json<{ action?: string; value?: string | number }>()
    .catch(() => ({}) as { action?: string; value?: string | number });
  const action = body.action?.trim() as LightAction | undefined;
  if (!action || !LIGHT_ACTIONS.includes(action)) {
    return c.json({ ok: false, error: `action inválida (${LIGHT_ACTIONS.join("|")})` }, 400);
  }
  const res = await lightsCommand(action, body.value == null ? undefined : String(body.value));
  if (res.ok && action !== "status") emit({ kind: "lights", detail: `luces · ${res.detail}` });
  return c.json(res);
});

app.get("/lights/state", async (c) => c.json(await lightsCommand("status")));


// ── Tracker de tareas por proyecto ─────────────────────────────────────
// Prefijo /tracker para no chocar con /tasks (tareas async del SDK/voz).

app.get("/tracker/tasks", async (c) =>
  c.json(
    await listTrackerTasks({
      project: c.req.query("project") || undefined,
      status: (c.req.query("status") as TaskState) || undefined,
    }),
  ),
);

app.post("/tracker/tasks", async (c) => {
  const { project, title, detail } = await c.req
    .json<{ project?: string; title?: string; detail?: string }>()
    .catch(() => ({ project: undefined, title: undefined, detail: undefined }));
  if (!project || !title?.trim()) return c.json({ error: "project y title requeridos" }, 400);
  return c.json(await createTask({ project, title: title.trim(), detail, source: "manual" }));
});

app.get("/tracker/tasks/:id", async (c) => {
  const task = await getTrackerTask(Number(c.req.param("id")));
  if (!task) return c.json({ error: "tarea no encontrada" }, 404);
  return c.json(task);
});

app.post("/tracker/tasks/:id", async (c) => {
  const patch = await c.req.json<{ title?: string; detail?: string }>().catch(() => ({}));
  return c.json(await updateTask(Number(c.req.param("id")), patch));
});

app.post("/tracker/tasks/:id/status", async (c) => {
  const { status } = await c.req.json<{ status?: TaskState }>().catch(() => ({ status: undefined }));
  if (!status) return c.json({ error: "status requerido" }, 400);
  return c.json(await setTaskStatus(Number(c.req.param("id")), status));
});

app.post("/tracker/tasks/:id/execute", async (c) => {
  const res = await executeTask(Number(c.req.param("id")));
  if (!res) return c.json({ error: "no se pudo ejecutar (sin tarea o sin Supabase)" }, 400);
  return c.json({ run_id: res.runId, session_id: res.sessionId, slug: res.slug });
});

// Continuar/enviar otro prompt: resume la sesión de la tarea con un run nuevo.
app.post("/tracker/tasks/:id/continue", async (c) => {
  const { prompt } = await c.req.json<{ prompt?: string }>().catch(() => ({ prompt: undefined }));
  const res = await continueTask(Number(c.req.param("id")), prompt);
  if (!res) return c.json({ error: "no se pudo continuar (sin tarea o sin Supabase)" }, 400);
  return c.json({ run_id: res.runId, session_id: res.sessionId, slug: res.slug });
});

// Historial de ejecuciones de una tarea (memoria: prompt · análisis · resultado).
app.get("/tracker/tasks/:id/executions", async (c) => {
  const task = await getTrackerTask(Number(c.req.param("id")));
  if (!task) return c.json({ error: "tarea no encontrada" }, 404);
  return c.json(await listExecutions(task.project_slug, task.id));
});

// Documento completo de una ejecución (con markdown para renderizar en la web).
app.get("/tracker/executions/:project/:id", async (c) => {
  const exec = await getExecution(c.req.param("project"), c.req.param("id"));
  if (!exec) return c.json({ error: "ejecución no encontrada" }, 404);
  return c.json(exec);
});

app.post("/tracker/import/:project", async (c) =>
  c.json(await importVaultTasks(c.req.param("project"))),
);

// Arregla tareas 'running' huérfanas (run muerto por reinicio del agente).
app.post("/tracker/reconcile", async (c) => c.json({ fixed: await reconcileRunningTasks() }));






// ── Claude Code (CLI real): Terminal.app + panel embebido ──────────────
interface ClaudeExecBody {
  prompt?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  project?: string;
  /** Si viene, se resume esa sesión de Claude Code en vez de crear una nueva. */
  resumeSessionId?: string;
}

// Abre una ventana de Terminal.app real con `claude` interactivo.
app.post("/claude/terminal", async (c) => {
  const b = await c.req.json<ClaudeExecBody>().catch(() => ({}) as ClaudeExecBody);
  if (!b.prompt?.trim()) return c.json({ error: "prompt requerido" }, 400);
  const res = await openClaudeTerminal({
    prompt: b.prompt,
    model: b.model,
    effort: b.effort,
    permissionMode: b.permissionMode,
    projectContext: b.project,
  });
  if (!res.ok) return c.json({ ok: false, error: res.error }, 500);
  emit({ kind: "tool_call", toolName: "claude(terminal)", detail: b.prompt.slice(0, 120) });
  return c.json({ ok: true });
});

// Inicia una corrida headless de `claude -p` y transmite por SSE al panel.
app.post("/claude/run", async (c) => {
  const b = await c.req.json<ClaudeExecBody>().catch(() => ({}) as ClaudeExecBody);
  if (!b.prompt?.trim()) return c.json({ error: "prompt requerido" }, 400);

  const projectSlug = b.project || "general";

  // Resume una sesión existente, o crea una nueva con un id fresco.
  // resumeSessionId viene del cliente → se exige formato uuid antes de pasarlo
  // a `claude --resume` (evita que un valor con "-" se cuele como flag del CLI).
  let sessionId: string;
  let resumeSdkSessionId: string | undefined;
  let existing: Awaited<ReturnType<typeof getClaudeSession>> = null;
  if (b.resumeSessionId && UUID_RE.test(b.resumeSessionId)) {
    sessionId = b.resumeSessionId;
    existing = await getClaudeSession(projectSlug, b.resumeSessionId);
    // sdkSessionId sale del CLI/nuestro uuid; validado también por si acaso.
    const candidate = existing?.sdkSessionId ?? b.resumeSessionId;
    resumeSdkSessionId = UUID_RE.test(candidate) ? candidate : b.resumeSessionId;
  } else {
    sessionId = randomUUID();
  }

  // cwd: al resumir, la MISMA carpeta con que se creó la sesión (así el CLI la
  // encuentra aunque cambie el ruta_local); si no, el repo local del proyecto.
  let cwd: string | undefined = existing?.cwd || undefined;
  if (!cwd && b.project) {
    const p = (await readProjects()).find(
      (x) => x.slug.toLowerCase() === b.project!.toLowerCase(),
    );
    // resolveProjectRoot, no ruta_local a secas: en otra máquina el mismo
    // proyecto vive en otra carpeta (y correr en el cwd equivocado es peor
    // que no correr).
    if (p) cwd = resolveProjectRoot(p) ?? undefined;
  }

  const run = startClaudeRun({
    prompt: b.prompt,
    model: b.model,
    effort: b.effort,
    permissionMode: b.permissionMode,
    projectContext: b.project,
    cwd,
    projectSlug,
    sessionId,
    resumeSdkSessionId,
  });
  emit({
    kind: "task_start",
    taskId: run.id,
    detail: `claude -p${resumeSdkSessionId ? " (resume)" : ""}: ${b.prompt.slice(0, 100)}`,
  });
  return c.json({
    run_id: run.id,
    session_id: sessionId,
    status: run.status,
    model: run.model,
    effort: run.effort,
    permissionMode: run.permissionMode,
  });
});

// Runs de Claude Code vivos (en curso o recién terminados) de TODOS los
// proyectos → panel Orquestador del dashboard.
app.get("/claude/runs", (c) => c.json(listClaudeRuns()));

// Cancela un run en curso (botón ✕ del Orquestador).
app.post("/claude/run/:id/kill", (c) => {
  const res = killClaudeRun(c.req.param("id"));
  if (res.ok) emit({ kind: "tool_call", toolName: "claude(kill)", detail: c.req.param("id") });
  return c.json(res, res.ok ? 200 : 400);
});

// ── Sesiones de Claude Code (CLI) por proyecto: listar · leer · borrar ──
app.get("/claude/sessions/:project", async (c) =>
  c.json(await listClaudeSessions(c.req.param("project"))),
);

app.get("/claude/sessions/:project/:id", async (c) => {
  const session = await getClaudeSession(c.req.param("project"), c.req.param("id"));
  if (!session) return c.json({ error: "sesión no encontrada" }, 404);
  return c.json(session);
});

app.delete("/claude/sessions/:project/:id", async (c) => {
  await deleteClaudeSession(c.req.param("project"), c.req.param("id"));
  return c.json({ ok: true });
});

// SSE del stream de una corrida embebida (replay + live).
app.get("/claude/run/:id/stream", (c) => {
  const id = c.req.param("id");
  const run = getClaudeRun(id);
  if (!run) return c.json({ error: "run no encontrada" }, 404);

  return streamSSE(c, async (stream) => {
    let queue: Promise<unknown> = Promise.resolve();
    const send = (event: string, data: unknown) => {
      queue = queue.then(() =>
        stream.writeSSE({ event, data: typeof data === "string" ? data : JSON.stringify(data) }),
      );
      return queue;
    };

    let ended = false;
    const finish = async () => {
      if (ended) return;
      ended = true;
      const cur = getClaudeRun(id) ?? run;
      await send("status", { status: cur.status, exitCode: cur.exitCode });
      await send("end", "[DONE]");
    };
    const isTerminal = (line: ClaudeLine) =>
      (line.kind === "done" || line.kind === "error") && line.text.includes("finalizó");

    // Snapshot del buffer + suscripción en el MISMO tick (sin await entre medias)
    // → ni el shift() del buffer ni la ventana de replay pierden líneas.
    const snapshot = [...run.lines];
    const pending: ClaudeLine[] = [];
    let replaying = true;
    let unsub: (() => void) | null = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        unsub?.();
        resolve();
      };
      const handle = (line: ClaudeLine) => {
        void send("line", line);
        if (isTerminal(line)) void finish().then(settle);
      };

      unsub = subscribeClaudeRun(id, (line) => {
        if (replaying) pending.push(line);
        else handle(line);
      });
      c.req.raw.signal.addEventListener("abort", settle);

      void (async () => {
        for (const line of snapshot) await send("line", line);
        replaying = false;
        for (const line of pending) handle(line);
        pending.length = 0;
        // Si sigue viva, el subscriber cerrará al ver la línea terminal.
        const cur = getClaudeRun(id) ?? run;
        if (cur.status === "running") return;
        await finish(); // idempotente
        settle();
      })();
    });
    await finish();
  });
});

// Búsqueda unificada para el dashboard / debugging (mismos filtros que la tool).
app.post("/knowledge/search", async (c) => {
  type KnowledgeSearchBody = { query?: string; sources?: string[]; project?: string; limit?: number };
  const body = await c.req.json<KnowledgeSearchBody>().catch(() => ({}) as KnowledgeSearchBody);
  if (!body.query) return c.json({ error: "query requerido" }, 400);
  const hits = await searchKnowledge(body.query, {
    sources: body.sources as never,
    project: body.project,
    limit: body.limit,
  });
  return c.json(hits);
});


// ── Stream de actividad en vivo (dashboard) ────────────────────────────
app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    for (const ev of recentEvents().slice(-30)) {
      await stream.writeSSE({ data: JSON.stringify(ev) });
    }
    let open = true;
    const unsubscribe = subscribe((ev) => {
      if (open) void stream.writeSSE({ data: JSON.stringify(ev) });
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
    });
    // Heartbeat para mantener viva la conexión
    while (open) {
      await new Promise((r) => setTimeout(r, 15000));
      if (open) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }
  }),
);

// ── Vitals para el dashboard ───────────────────────────────────────────
app.get("/stats", async (c) => {
  const projects = await readProjects();
  const tasks = listTasks();
  const today = new Date().toISOString().slice(0, 10);
  const dailyUsage = await getDailyUsage();
  return c.json({
    memories: await memoriesCount(),
    activeProjects: projects.filter((p) => p.estado === "activo").length,
    totalProjects: projects.length,
    sessionsToday: tasks.filter((t) => t.startedAt.startsWith(today)).length,
    tasksToday: tasks.filter((t) => t.startedAt.startsWith(today)).length,
    // Gasto real del día en runs de Claude Code (acumulador persistente).
    dailyRunCostUsd: dailyUsage.costUsd,
    runsToday: dailyUsage.runs,
    machine: env.MACHINE_NAME,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    supabase: hasSupabase(),
    presence: getPresence(),
  });
});

app.get("/projects", async (c) => c.json(await readProjects()));

// Resuelve un .md del vault desde una referencia (wikilink `[[x]]` o ruta `x.md`)
// para el visor tipo Notion del dashboard. `project` desambigua nombres repetidos.
app.get("/vault/doc", async (c) =>
  c.json(await resolveVaultDoc(c.req.query("ref") ?? "", c.req.query("project") || undefined)),
);

// Contexto operativo de un proyecto (skills · MCP · tools · comandos).
app.get("/projects/:slug/context", async (c) =>
  c.json(await readProjectContext(c.req.param("slug"))),
);

// Abre el repo local del proyecto en Cursor (la ruta se resuelve en el server).
app.post("/projects/:slug/open-editor", async (c) => {
  const slug = c.req.param("slug");
  const project = (await readProjects()).find(
    (p) => p.slug.toLowerCase() === slug.toLowerCase(),
  );
  if (!project?.ruta_local) {
    return c.json({ ok: false, error: "el proyecto no tiene ruta_local en el vault" }, 400);
  }
  const res = await openInCursor(project.ruta_local);
  if (res.ok) emit({ kind: "tool_call", toolName: "open(cursor)", detail: project.name });
  return c.json(res, res.ok ? 200 : 500);
});

app.get("/memories/recent", async (c) => c.json(await recentMemories(12)));

// ── Datos del dashboard (rediseño) ─────────────────────────────────────
// Regla: nunca 500 — cada fuente degrada a su fallback y el panel del front
// se auto-oculta o muestra su CTA.

// Métricas del Mac local (CPU/RAM/disco/uptime).
app.get("/system", async (c) =>
  c.json(await getSystemMetrics(Math.floor((Date.now() - startedAt) / 1000))),
);

// Presencia de TODAS las Macs (agent_presence + estado local exacto).
app.get("/presence", async (c) => c.json(await listPresence()));

// Máquinas de la red interna: la misma presencia, pero pensada para el selector
// del dashboard (quién está vivo, cómo se le habla y qué puede hacer). Es una
// ruta propia porque el selector la pide antes de que cargue nada más.
app.get("/machines", async (c) => c.json({ machines: await listPresence() }));

// Conteos reales de la base de conocimiento (panel MEMORIA ACTIVA).
app.get("/knowledge/stats", async (c) => c.json(await knowledgeStats()));

// Conteos del tracker por estado (+ ?project= y ?byProject=1).
app.get("/tracker/summary", async (c) =>
  c.json(
    await trackerSummary({
      project: c.req.query("project") || undefined,
      byProject: c.req.query("byProject") === "1",
    }),
  ),
);

// Estado de los jobs periódicos (panel AUTOMATIZACIONES).
app.get("/jobs", (c) => c.json(listJobs()));

// Serie horaria de actividad (área chart 24h).
app.get("/activity/hourly", async (c) =>
  c.json(await activityHourly(Math.min(Number(c.req.query("hours")) || 24, 168))),
);

// Agregador: UN solo poll para todo el strip inferior + presencia. Cada
// sección es independiente (allSettled): si una fuente falla, llega null o
// su fallback y el resto vive.
app.get("/dashboard", async (c) => {
  const uptimeAgent = Math.floor((Date.now() - startedAt) / 1000);
  const [system, presence, knowledge, tracker, activity, usage] =
    await Promise.allSettled([
      getSystemMetrics(uptimeAgent),
      listPresence(),
      knowledgeStats(),
      trackerSummary(),
      activityHourly(24),
      getDailyUsage(),
    ]);
  const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === "fulfilled" ? r.value : fallback;
  return c.json({
    generatedAt: new Date().toISOString(),
    machine: env.MACHINE_NAME,
    system: val(system, {
      cpuPct: 0,
      loadAvg1: 0,
      memUsedPct: 0,
      memTotalBytes: 0,
      memUsedBytes: 0,
      diskUsedPct: 0,
      diskTotalBytes: 0,
      diskFreeBytes: 0,
      uptimeOsSeconds: 0,
      uptimeAgentSeconds: uptimeAgent,
    }),
    presence: val(presence, []),
    knowledge: val(knowledge, {
      available: false,
      total: 0,
      memories: 0,
      vaultDocs: 0,
      meetings: 0,
      executions: 0,
      conversationText: 0,
      conversationVoice: 0,
    }),
    tracker: val(tracker, {
      available: false,
      pending: 0,
      running: 0,
      done: 0,
      dismissed: 0,
    }),
    jobs: listJobs(),
    activity: val(activity, null),
    usage: val(usage, { costUsd: 0, runs: 0 }),
  });
});

// ── Boot ───────────────────────────────────────────────────────────────
startSystemSampler(); // sampler de CPU (5s) para GET /system
void readProjects(); // primer parse + sync a projects_cache
void reconcileRunningTasks(); // arregla tareas 'running' huérfanas de un reinicio

// Jobs periódicos con estado observable (GET /jobs → panel AUTOMATIZACIONES).
// Presencia: latido para que otras Macs sepan que estamos vivos.
registerJob("presence-heartbeat", 30_000, pushPresence, () =>
  hasSupabase() ? "latido enviado" : null,
);
// Índice semántico del vault: por hash — si nada cambió, 0 llamadas a OpenAI.
registerJob("vault-knowledge-sync", 10 * 60_000, syncVaultKnowledge, (r) =>
  r ? `${r.indexed} notas vectorizadas, ${r.removed} eliminadas (${r.scanned} escaneadas)` : null,
);
// Grafo de código (graphify): refresca hermes-os + proyectos activos con repo git.
registerJob("code-graph-update", 6 * 60 * 60_000, updateCodeGraph, (r) =>
  r
    ? `${r.total} repos: ${r.updated} actualizados, ${r.built} nuevos${r.failed ? `, ${r.failed} con error` : ""}`
    : null,
);

// Bind explícito: sin API key SOLO loopback (antes escuchaba en todas las
// interfaces con la LAN sin auth); con key se abre a 0.0.0.0 para que otra
// Mac llegue por Tailscale con Bearer/?key=.
const hostname = env.HERMES_API_KEY ? "0.0.0.0" : "127.0.0.1";
// WS nativo de @hono/node-server v2: el server de `ws` va en noServer y el
// adapter le enruta los upgrades que pasaron por la app (auth incluida).
const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, port: env.PORT, hostname, websocket: { server: wss } }, (info) => {
  console.log(`\n⚡ Hermes agent server → http://localhost:${info.port}`);
  console.log(
    env.HERMES_API_KEY
      ? "   modo: RED (0.0.0.0) con HERMES_API_KEY — accesible vía Tailscale"
      : "   modo: solo esta máquina (127.0.0.1)",
  );
  console.log(`   vault: ${env.VAULT_PATH || "(sin configurar)"}`);
  console.log(`   supabase: ${hasSupabase() ? "conectado" : "no configurado"}`);
  // Qué quedó apagado, explícito al arrancar: si una ruta responde 404 más
  // tarde, esta línea es la respuesta y no hay que ir a leer el .env.
  const feats = featureSummary();
  if (feats.off.length) console.log(`   apagadas: ${feats.off.join(", ")}`);
  console.log(`   embeddings: ${EMB.provider} (${EMB.dims}d → ${EMB.col})`);
  // La política de modelos, explícita: qué rol usa qué. Sin esto, saber por
  // qué un turno salió caro obliga a leer el .env y tres archivos.
  console.log(`   modelos: ${modelSummary()}`);
  // El modo de consumo, visible al arrancar: si el agente responde más corto
  // de lo normal, esta línea es la explicación.
  void budgetState().then((b) =>
    console.log(
      `   consumo: ${b.mode}${b.sessionUtilization != null ? ` (sesión ${b.sessionUtilization}%)` : ""} — ${b.reason}`,
    ),
  );
});

// El proceso del CLI del reloj se levanta AL ARRANCAR, no en la primera
// pregunta: así el primer dictado del día ya lo encuentra caliente en vez de
// pagar los ~5 s de arranque justo cuando alguien está mirando la muñeca.
relojRapido.calentar();
