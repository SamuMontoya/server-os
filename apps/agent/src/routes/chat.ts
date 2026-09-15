import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { env } from "../env.js";
import { withUser } from "../auth.js";
import { getSdkSession } from "../agent/session.js";
import { listChatSessions, readChatSession, resolveChatCwd } from "../agent/chat-history.js";
import { chatTurns, turnVisibleTo, type TurnEvent } from "../agent/chat-turns.js";
import { titleForChat } from "../agent/chat-title.js";
import { gistForAnswer } from "../agent/chat-gist.js";
import {
  chatAttachmentPath,
  resolveChatAttachments,
  saveChatAttachment,
  MAX_ATTACHMENT_BYTES,
} from "../chat-attachments.js";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS_PER_UPLOAD } from "../documents/chat-documents.js";
import { startChatDocumentJobs, getDocJobs } from "../documents/chat-document-jobs.js";
// El dictado del composer usaba el mismo STT que las juntas (Scribe → Whisper).
import { transcribe } from "../stt.js";
import {
  getConversation,
  clearConversation,
  archiveConversation,
  listChats,
  restoreChat,
  messageVisibleTo,
} from "../conversations.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function registerChatRoutes(app: Hono): void {
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
      userId: withUser(c).get("userId"),
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
   * Sube uno o varios documentos (PDF/DOCX/XLSX/PPTX/EPUB/TXT/MD/CSV/JSON/SVG
   * o imágenes JPG/PNG/WEBP/BMP/TIFF/GIF vía OCR) y los pone A VECTORIZAR EN
   * BACKGROUND — nunca el contenido ni una ruta en disco. El archivo original
   * NO se guarda: se procesa en memoria y se descarta apenas se extrae el
   * texto (a diferencia de las imágenes pegadas/soltadas para visión vía
   * /chat/attachments, que sí persisten para que el modelo las pueda releer —
   * el clip y el paste son rutas distintas para imágenes, ver addFiles en el
   * frontend).
   *
   * ASÍNCRONO desde 2026-09-15 (auditoría: un PDF de 2MB tardaba ~2-3 min de
   * Ollama serial en 1 vCPU, y ese tiempo entero bloqueaba este request). Acá
   * solo se valida y se ENCOLA — responde 202 con los docId en "processing"
   * apenas los archivos llegaron, sin esperar extracción/chunking/embeddings.
   * El cliente hace polling a `GET /chat/documents/status` (ver más abajo)
   * hasta que cada uno quede "ready" o "error" — ver chat-document-jobs.ts
   * para el motor que corre el trabajo pesado fuera de este ciclo request/
   * response, mismo patrón que los turnos de chat (chat-turns.ts).
   *
   * Automático por diseño: no hay confirmación intermedia, igual que
   * `/chat/attachments` sube la imagen apenas se pega.
   */
  app.post(
    "/chat/documents",
    bodyLimit({ maxSize: MAX_DOCUMENT_BYTES * MAX_DOCUMENTS_PER_UPLOAD + 2 * 1024 * 1024 }),
    async (c) => {
      const body = await c.req.parseBody({ all: true }).catch(() => null);
      const raw = body?.["files"];
      const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
        (f): f is File => f instanceof File,
      );
      if (files.length === 0) return c.json({ error: "campo 'files' requerido" }, 400);
      if (files.length > MAX_DOCUMENTS_PER_UPLOAD) {
        return c.json({ error: `máximo ${MAX_DOCUMENTS_PER_UPLOAD} archivos por subida` }, 400);
      }
      for (const f of files) {
        if (f.size === 0) return c.json({ error: `"${f.name}" llegó vacío` }, 400);
        if (f.size > MAX_DOCUMENT_BYTES) {
          const mb = (f.size / 1024 / 1024).toFixed(1);
          return c.json(
            { error: `"${f.name}" pesa ${mb} MB (máximo ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB)` },
            400,
          );
        }
      }
      const input = await Promise.all(
        files.map(async (f) => ({
          name: f.name || "documento",
          mimeType: f.type || "",
          buffer: Buffer.from(await f.arrayBuffer()),
        })),
      );
      const processing = startChatDocumentJobs(input);
      return c.json({ processing }, 202);
    },
  );

  /**
   * Estado de una tanda de documentos subidos al chat, por docId — el
   * polling que reemplaza la espera bloqueante de antes. `ids` es una lista
   * separada por comas. Ids desconocidos (nunca existieron o se evictaron
   * tras 30 min) vuelven como `{ status: "not_found" }` en vez de romper la
   * respuesta entera: el frontend los trata como error terminal y deja de
   * insistir.
   */
  app.get("/chat/documents/status", (c) => {
    const raw = c.req.query("ids") ?? "";
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return c.json({ error: "ids requerido" }, 400);
    return c.json({ jobs: getDocJobs(ids) });
  });

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
      userId: withUser(c).get("userId"),
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

  /** Estado + lo que falte desde `from`. Es lo que pide quien vuelve. */
  app.get("/chat/turns/:id", (c) => {
    const id = c.req.param("id");
    const turn = chatTurns.get(id);
    // Mismo 404 tanto si el turno no existe como si es de otro usuario: no
    // hay que confirmarle a nadie que un turno ajeno existe.
    if (!turn || !turnVisibleTo(turn, withUser(c).get("userId"))) {
      return c.json({ error: "turno no encontrado" }, 404);
    }
    const from = Number(c.req.query("from") ?? 0) || 0;
    const snap = chatTurns.snapshot(id, from);
    if (!snap) return c.json({ error: "turno no encontrado" }, 404);
    return c.json(snap);
  });

  /** Turnos recientes de un tab: permite re-engancharse sin recordar el id. */
  app.get("/chat/turns", (c) => {
    const session = c.req.query("session");
    if (!session) return c.json({ error: "session requerido" }, 400);
    const userId = withUser(c).get("userId");
    const turns = chatTurns.listBySession(session, Number(c.req.query("limit") ?? 5) || 5);
    return c.json(turns.filter((t) => turnVisibleTo(t, userId)));
  });

  app.post("/chat/turns/:id/stop", (c) => {
    const id = c.req.param("id");
    const turn = chatTurns.get(id);
    if (!turn || !turnVisibleTo(turn, withUser(c).get("userId"))) return c.json({ ok: false });
    const stopped = chatTurns.stop(id);
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
    const turn = chatTurns.get(id);
    if (!turn || !turnVisibleTo(turn, withUser(c).get("userId"))) {
      return c.json({ error: "turno no encontrado" }, 404);
    }

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
    const userId = withUser(c).get("userId");
    const messages = await getConversation(project);
    // El proyecto es la clave del archivo, no el dueño: sin este filtro,
    // cualquier usuario de Supabase con acceso lee la consola de CUALQUIER
    // otro (ver messageVisibleTo — mensajes sin userId, de antes de este
    // campo o de la key estática, se quedan visibles para todos).
    const visible = messages.filter((m) => messageVisibleTo(m, userId));
    return c.json(visible.slice(-200)); // últimos 200 mensajes
  });

  // Borra el archivo entero del proyecto, no solo los mensajes propios —
  // comportamiento sin cambios: "vaciar la consola" es una acción explícita
  // sobre el proyecto, no sobre un mensaje puntual, y partirla por dueño
  // dejaría el archivo en un estado a medias que nadie pidió.
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
  //
  // NO están filtrados por userId como el GET de arriba: son archivos por
  // proyecto que pueden mezclar mensajes de varios usuarios, y separarlos
  // (título del primer mensaje, conteo, restore parcial) exigiría partir
  // cada chat archivado a mitad de camino — un cambio de forma, no un
  // filtro. Gap conocido y documentado, no arreglado en esta pasada: el
  // riesgo real es bajo hoy (mono-usuario, allowlist de correos) pero crece
  // si el allowlist se abre a más gente.
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
}
