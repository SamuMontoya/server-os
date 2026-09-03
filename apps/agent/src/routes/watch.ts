import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import {
  relojRapido,
  CENTINELA,
  CENTINELA_IMAGEN,
  CENTINELA_OTRA,
  ESTILO_ESCALADA,
} from "../watch/rapido.js";
import { buscarImagen } from "../watch/imagen.js";
import { capturarIdea, CENTINELA_IDEA } from "../watch/intenciones.js";
import { limitesDelPlan } from "../limits.js";
import * as relojTurnos from "../watch/turnos.js";
import * as relojVinculo from "../watch/active-link.js";
import { chatTurns, type TurnEvent } from "../agent/chat-turns.js";
import { resolveChatCwd } from "../agent/chat-history.js";

/**
 * Última imagen enseñada en el reloj, para poder pasar a la siguiente.
 *
 * Vive en memoria del proceso y no en la base de datos a propósito: "esa no,
 * otra" solo tiene sentido en los segundos siguientes, y persistirlo obligaría
 * a decidir cuándo caduca.
 */
let ultimaImagen: { q: string; indice: number } | null = null;

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

export function registerWatchRoutes(app: Hono): void {
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

  /**
   * Consumo del plan, para el pie del chat del reloj y del iPhone.
   *
   * La web lo lee ella misma con su propia ruta de Next; esos clientes no
   * pueden, así que lo expone el agente. Cachea 60s: lo pide un cliente por
   * turno y el endpoint de origen es de Anthropic, no nuestro.
   */
  app.get("/limits", async (c) => c.json(await limitesDelPlan()));

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
}
