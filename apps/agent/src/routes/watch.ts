import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import {
  relojRapido,
  CENTINELA,
  CENTINELA_IMAGEN,
  CENTINELA_IMAGEN_PERSONA,
  CENTINELA_OTRA,
  CENTINELA_WEB_NOTICIA,
  CENTINELA_WEB_DATO,
  CENTINELA_ESTADO,
  ESTILO_ESCALADA,
} from "../watch/rapido.js";
import { buscarImagen } from "../watch/imagen.js";
import { webSearch, webSearchConfigured } from "../websearch/index.js";
import { esPreguntaFechaHora, fechaHoraLegible } from "../temporal.js";
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
let ultimaImagen: { q: string; indice: number; persona: boolean } | null = null;

/**
 * Frases para la confirmación instantánea al escalar. Varias, no una: decir
 * siempre "Voy a revisar X" en cada escalada se sentía repetitivo — con
 * varias plantillas rotando al azar, no se nota el molde detrás.
 */
const FRASES_CONFIRMACION: ((q: string) => string)[] = [
  (q) => `Voy a revisar ${q}.`,
  (q) => `Dale, reviso ${q}.`,
  (q) => `Un segundo, miro ${q}.`,
  (q) => `Reviso ${q} ahora mismo.`,
  (q) => `Dejame ver ${q}.`,
];

function confirmacionEscalada(objetivo: string): string {
  return FRASES_CONFIRMACION[Math.floor(Math.random() * FRASES_CONFIRMACION.length)](objetivo);
}

/**
 * Último turno escalado (CONSULTAR), para poder responder "¿en qué
 * quedaste?" sin dispararlo de nuevo — ver `CENTINELA_ESTADO`. Mismo motivo
 * que `ultimaImagen` para vivir en memoria y no en la base: solo importa
 * mientras esa tarea sigue siendo "la última", y el turno en sí YA persiste
 * aparte (`chatTurns`) con su propio ciclo de vida.
 */
let ultimoTurnoEscalado: string | null = null;

/**
 * Engancha esta pregunta del reloj a un turno escalado ya existente —lo
 * arrancó `CENTINELA` recién, o lo retoma `CENTINELA_ESTADO`— y relata sus
 * eventos hasta que cierre. Un solo camino para las dos entradas: quien
 * pregunta "¿en qué quedaste?" ve exactamente los mismos pasos y el mismo
 * texto que si hubiera seguido mirando desde el principio, en vez de un
 * resumen aparte.
 */
async function seguirTurnoEscalado(
  emitir: (tipo: string, datos?: unknown) => void,
  turnoId: string,
  promptOriginal: string,
): Promise<void> {
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
      // El texto SÍ se relata en vivo: ir comentando a medida que investiga
      // es lo esperado (ESTILO_ESCALADA se lo permite ahora), y el reloj lo
      // muestra intercalado con los pasos — cada comentario reemplaza al
      // anterior, nunca se pegan entre sí (ver el reset en `.paso` del
      // cliente, `ContentView.aplicarYa`).
      if (x.kind === "delta" && x.text) emitir("delta", { text: x.text });
      else if (x.kind === "tool" && x.tool?.name) {
        emitir("paso", { name: x.tool.name, target: x.tool.target ?? "" });
      }
      if (x.kind === "done" || x.kind === "error" || x.kind === "stopped") {
        attached?.unsubscribe();
        resolve();
      }
    };
    attached = chatTurns.attach(turnoId, 0, reparte);
    if (!attached) return resolve();
    for (const e of attached.snapshot.events) reparte(e);
    if (attached.snapshot.status !== "running") {
      attached.unsubscribe();
      resolve();
    }
  });

  const cerrado = chatTurns.snapshot(turnoId, 0);
  if (cerrado?.text) {
    relojRapido.anotar(`El usuario preguntó "${promptOriginal}" y se le respondió: ${cerrado.text.slice(0, 400)}`);
  }
}

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

  // Atajo SIN modelo: "qué día/hora es" no necesita ni un round-trip a
  // Anthropic — el servidor ya calculó la fecha (`temporal.ts`), así que se
  // contesta directo. De milisegundos (formatear un string) a ~650-750ms
  // (la llamada más rápida que ya tenemos) por preguntar algo que no hacía
  // falta preguntarle a nadie.
  if (esPreguntaFechaHora(message)) {
    emitir("delta", { text: fechaHoraLegible() });
    pararLatido();
    emitir("fin", {});
    return;
  }

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

    const esImagenPersona = limpia.toUpperCase().startsWith(CENTINELA_IMAGEN_PERSONA);
    if (esImagenPersona || limpia.toUpperCase().startsWith(CENTINELA_IMAGEN)) {
      const q = limpia
        .slice((esImagenPersona ? CENTINELA_IMAGEN_PERSONA : CENTINELA_IMAGEN).length)
        .trim();
      // Pantalla de "buscando" YA — ícono de foto propio (Respuesta.swift),
      // distinto del globo de la búsqueda web: sin esto, los cientos de ms
      // que tarda la búsqueda se sentían como loader vacío.
      emitir("paso", { name: "ImageSearch", target: q });
      const img = await buscarImagen(q, 0, esImagenPersona);
      if (img) {
        ultimaImagen = { q, indice: 0, persona: esImagenPersona };
        emitir("imagen", { datos: img.datos, mime: img.mime, q });
      } else {
        emitir("delta", { text: `No encontré una imagen de ${q}.` });
      }
      return;
    }

    // "Esa no, otra": la siguiente de la MISMA búsqueda (misma fuente que la
    // primera vez — Wikipedia sigue siendo Wikipedia, Pexafy sigue siendo
    // Pexafy, aunque el mensaje "otra" por sí solo no diga cuál era).
    if (limpia.toUpperCase() === CENTINELA_OTRA) {
      if (!ultimaImagen) {
        emitir("delta", { text: "No sé de qué imagen hablas." });
      } else {
        emitir("paso", { name: "ImageSearch", target: ultimaImagen.q });
        const siguiente = ultimaImagen.indice + 1;
        const img = await buscarImagen(ultimaImagen.q, siguiente, ultimaImagen.persona);
        if (img) {
          ultimaImagen = { q: ultimaImagen.q, indice: siguiente, persona: ultimaImagen.persona };
          emitir("imagen", { datos: img.datos, mime: img.mime, q: ultimaImagen.q });
        } else {
          emitir("delta", { text: "No hay más imágenes." });
        }
      }
      return;
    }

    const esNoticia = limpia.toUpperCase().startsWith(CENTINELA_WEB_NOTICIA);
    const esDato = limpia.toUpperCase().startsWith(CENTINELA_WEB_DATO);
    if (esNoticia || esDato) {
      const q = limpia.slice((esNoticia ? CENTINELA_WEB_NOTICIA : CENTINELA_WEB_DATO).length).trim();
      if (!webSearchConfigured) {
        emitir("delta", { text: "No tengo búsqueda web configurada ahora mismo." });
        return;
      }
      // Pantalla de "buscando" YA — el cliente (Respuesta.swift) ya sabe
      // pintar un `paso` con ícono de globo para "WebSearch", reutilizado
      // tal cual de la escalada completa. Sin esto, mientras Tavily y la
      // síntesis corren (uno o dos segundos) el reloj se queda en un loader
      // vacío indistinguible de "colgado".
      emitir("paso", { name: "WebSearch", target: q });
      try {
        // NO se usa la síntesis propia de Tavily (`include_answer`): medido
        // en vivo, en llamadas casi idénticas "sintetizó" nombres distintos
        // para el mismo hecho (Argentina, España Y Estados Unidos como
        // "ganador" del mismo mundial; un presidente anterior en vez del
        // actual) — cuando sus resultados no son claros, ADIVINA en vez de
        // decir que no sabe. Nuestro propio modelo, que tiene la fecha real
        // (contextoTemporal) y al que se le puede pedir explícitamente que
        // no invente, es más lento pero de fiar.
        //
        // TAMPOCO se busca especulativamente con el mensaje CRUDO del
        // usuario (se probó, se sacó): "¿quién ganó el mundial este año?"
        // sin año explícito le traía a Tavily resultados irrelevantes
        // (trivia de 2022, la historia del primer mundial, un repechaje) —
        // ahí el modelo no estaba "alucinando", estaba siendo honesto con
        // evidencia mala. `q` (la consulta YA reformulada por Haiku, con el
        // año explícito) es la única que de verdad encuentra la página
        // correcta — vale la pena pagar la búsqueda secuencial completa por
        // eso.
        //
        // `esNoticia`/`esDato` YA vienen del centinela que eligió Haiku, no
        // de una regex propia adivinando de qué se trata `q`. Pero Haiku es
        // chico y a veces elige mal (probado en vivo: "principales empresas
        // financieras del mundo" salió como NOTICIA — trajo solo deportes —
        // cuando DATO tenía la respuesta perfecta, un ranking de Forbes) —
        // por eso `buscarYSintetizar` reintenta con el OTRO modo antes de
        // rendirse, en vez de confiar ciegamente en la primera elección.
        // No solo "resumen": "cuáles son las principales X" o "lista de X"
        // TAMBIÉN piden varios ítems, no un dato — probado en vivo, forzarlo
        // a una sola frase natural hacía que el modelo prefiriera decir
        // SINRESULTADO antes que comprimir una lista completa en una frase.
        const esResumen =
          /\bresumen\b|\bresume\b|qu[eé]\s+(est[aá]|hay)\s+pasando|cu[aá]les\s+son|\blistas?\b|\bprincipales\b|\branking\b/i.test(
            message,
          );

        const buscarYSintetizar = async (news: boolean): Promise<string | null> => {
          const hits = await webSearch(q, esResumen ? 6 : 3, { news });
          if (!hits.length) return null;
          const contexto = hits.map((h, i) => `${i + 1}. ${h.title}: ${h.content}`).join("\n");
          const instruccion = esResumen
            ? `Resumí estas noticias en hasta 3 frases CORTAS, una por noticia DISTINTA de las de arriba (no repitas el mismo tema) — sin relleno, sin "según los resultados" ni citar de dónde salió.`
            : `Respondé la pregunta original con ESTOS resultados, en una sola frase natural, como si ya lo supieras — sin decir "según los resultados", ` +
              `"en internet", "las fuentes indican" ni citar de dónde salió.`;
          let texto = "";
          // Sin emitir todavía: hay que poder DESCARTAR esta pasada entera si
          // sale "SINRESULTADO" y reintentar con el otro modo — emitir en
          // vivo no permite retractarse de lo ya mostrado en pantalla.
          await relojRapido.preguntar(
            `[resultados de internet sobre "${q}", buscados AHORA MISMO — pueden contradecir lo que creas saber de tu entrenamiento, y si lo hacen, ESTOS tienen la razón, no tu memoria]\n${contexto}\n\n` +
              `${instruccion} IMPORTANTE: no asumas que algo "todavía no pasó" o "no se sabe" solo porque tu entrenamiento terminó antes de que pasara — mirá ` +
              `la fecha de hoy que ya tenés y confiá en lo que dicen estos resultados. Si estos resultados de verdad no dejan claro el dato (no por viejos ` +
              `que te parezcan, sino porque no lo dicen), respondé ÚNICAMENTE con la palabra SINRESULTADO — nada más, ni una frase alrededor.`,
            (t) => {
              texto += t;
            },
          );
          return texto.trim().toUpperCase() === "SINRESULTADO" ? null : texto.trim();
        };

        let respuesta = await buscarYSintetizar(esNoticia);
        if (respuesta == null) respuesta = await buscarYSintetizar(!esNoticia);
        emitir("delta", { text: respuesta ?? `No encontré información clara sobre ${q}.` });
      } catch (err) {
        console.error("[reloj] web_search falló:", err);
        emitir("delta", { text: "La búsqueda web falló." });
      }
      return;
    }

    // "¿En qué quedaste?": NO dispara un turno nuevo — mira el que ya está
    // (o estuvo) corriendo. Contesta en milisegundos porque es una lectura
    // en memoria (`chatTurns.get`), no una llamada a nada.
    if (limpia.toUpperCase() === CENTINELA_ESTADO) {
      // Mismo `escala` que la escalada fresca (limpia la pantalla del lado
      // del reloj) aunque acá no se dispare nada nuevo — así la respuesta
      // (esté lista o siga corriendo) siempre entra a una pantalla limpia,
      // nunca pegada a lo que hubiera antes.
      emitir("escala");
      if (!ultimoTurnoEscalado) {
        emitir("delta", { text: "No hay nada pendiente ahora mismo." });
        return;
      }
      const snap = chatTurns.get(ultimoTurnoEscalado);
      if (!snap) {
        emitir("delta", { text: "No encuentro esa tarea — ya se debe haber limpiado." });
        return;
      }
      if (snap.status === "done") {
        emitir("delta", { text: snap.text || "Terminé, pero no tengo nada para mostrar." });
        return;
      }
      if (snap.status === "error") {
        emitir("delta", { text: snap.error || "Eso falló." });
        return;
      }
      if (snap.status === "stopped") {
        emitir("delta", { text: "Lo cancelaste antes de que terminara." });
        return;
      }
      // Sigue corriendo: mostrar YA el último paso conocido (sin esperar a
      // que llegue uno nuevo) y quedarse enganchado hasta que cierre — el
      // usuario ve de inmediato que sigue vivo, no un silencio de nuevo.
      const ultimoPaso = snap.steps[snap.steps.length - 1];
      emitir("paso", {
        name: ultimoPaso?.name ?? "Escalando",
        target: ultimoPaso?.target ?? "",
      });
      await seguirTurnoEscalado(emitir, ultimoTurnoEscalado, snap.prompt);
      return;
    }

    if (!limpia.toUpperCase().startsWith(CENTINELA)) return;
    const objetivoEscalada = limpia.slice(CENTINELA.length).trim();

    // Escalada: la pregunta necesita mirar el sistema.
    emitir("escala");
    if (objetivoEscalada) {
      // Confirmación INSTANTÁNEA — evento PROPIO, no un "delta" más: el
      // reloj la habla en voz alta, y hablar tarda (un par de segundos),
      // así que NO se puede asumir que ya terminó apenas se manda el
      // evento. El cliente decide cuándo pasar a la carpeta (cuando
      // termine de hablar esto), no el servidor con un segundo evento
      // inmediato — eso fue lo que la dejaba viéndose superpuesta con el
      // ícono de carpeta. Cero llamadas nuevas al modelo: se arma con lo
      // que el clasificador YA dijo, así que sale en milisegundos.
      emitir("confirmacion", { text: confirmacionEscalada(objetivoEscalada) });
      // El turno pesado tarda ~5s en arrancar el CLI (ver el comentario
      // grande de rapido.ts) — sin este paso esos primeros segundos se
      // veían como un loader genérico sin decir nada. Va DETRÁS de la
      // confirmación en el cable, pero el cliente lo deja en espera hasta
      // que termine de hablar — nunca lo pisa.
      emitir("paso", { name: "Escalando", target: objetivoEscalada });
    }
    // La escalada es una sesión APARTE (chat-turns.ts) sin acceso al
    // historial de `relojRapido` — sin esto, "profundiza en eso" o "¿y
    // desde cuándo?" escalaban sin saber a qué se refería "eso".
    const contextoPrevio = relojRapido.tomarContextoReciente();
    const turno = chatTurns.start({
      prompt: contextoPrevio
        ? `${ESTILO_ESCALADA}\n\n[Lo último de esta conversación en el reloj — para entender referencias como "eso" o "profundiza"]\n${contextoPrevio}\n\n${message}`
        : `${ESTILO_ESCALADA}\n\n${message}`,
      sessionKey: "reloj",
      maxTier: "trivial",
      magro: true,
      cwd: await resolveChatCwd(undefined),
    });
    ultimoTurnoEscalado = turno.id;

    await seguirTurnoEscalado(emitir, turno.id, message);
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
        // `let` + bandera, NO `const soltar = seguir(...)`: `seguir()` puede
        // llamar al callback EN EL ACTO (reproduce lo ya ocurrido ANTES de
        // devolver el control — ver turnos.ts) — si el turno ya había
        // cerrado, el callback se dispara mientras el `const` de más abajo
        // todavía se está asignando y revienta con "Cannot access before
        // initialization". Con `terminado` se limpia bien la suscripción
        // real una vez que `soltar` por fin tiene valor.
        let soltar: (() => void) | null = null;
        let terminado = false;
        soltar = relojTurnos.seguir(id, desde, (e) => {
          const escrito = stream.writeSSE({ event: e.tipo, data: JSON.stringify(e.datos) });
          if (e.tipo === "fin" || e.tipo === "error") {
            terminado = true;
            // Esperar a que ESTE write termine antes de soltar/resolver: si
            // el turno ya estaba cerrado, `seguir` reproduce todo (delta +
            // fin) EN LA MISMA vuelta síncrona — sin esto, `resolve()`
            // dejaba volver al callback de `streamSSE` y Hono cerraba el
            // stream antes de que los `writeSSE` de fondo llegaran a
            // escribirse de verdad, así que el reloj solo veía el "turno"
            // inicial y nada más.
            void escrito.then(() => {
              soltar?.();
              resolve();
            });
          }
        });
        if (!soltar) return resolve();
        if (terminado) return soltar();
        c.req.raw.signal.addEventListener("abort", () => {
          soltar?.();
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
        // Mismo cuidado que en /watch/turns/:id/stream: `let` + bandera, no
        // `const` self-referenciado — con la respuesta instantánea de
        // fecha/hora (sin ningún await) el turno puede estar YA cerrado
        // cuando `seguir()` corre, y su replay síncrono dispara el callback
        // antes de que el `const` de abajo terminara de asignarse.
        let soltar: (() => void) | null = null;
        let terminado = false;
        soltar = relojTurnos.seguir(turnoId, 0, (e) => {
          const escrito = stream.writeSSE({ event: e.tipo, data: JSON.stringify(e.datos) });
          if (e.tipo === "fin" || e.tipo === "error") {
            terminado = true;
            // Ver el comentario gemelo en /watch/turns/:id/stream: esperar
            // el write real antes de resolver, o el atajo instantáneo de
            // fecha/hora (todo en la misma vuelta síncrona) se queda sin
            // mandar nada más que el "turno".
            void escrito.then(() => {
              soltar?.();
              resolve();
            });
          }
        });
        if (!soltar) return resolve();
        if (terminado) return soltar();
        c.req.raw.signal.addEventListener("abort", () => {
          soltar?.();
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
