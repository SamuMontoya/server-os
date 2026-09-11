/**
 * Canal RÁPIDO del reloj: llamada DIRECTA a la API de Anthropic, sin el CLI.
 *
 * POR QUÉ EXISTE (y por qué ya NO usa el Agent SDK)
 * Un turno normal tarda ~5 s en decir la primera palabra, y casi todo es
 * arrancar el proceso del CLI del SDK, no el modelo. La primera versión de
 * este canal resolvía eso con una sesión PERSISTENTE del SDK (el proceso
 * quedaba vivo, se pagaba el arranque una sola vez). Funcionaba: ~1 s de
 * ttft en vez de ~5 s.
 *
 * Medido después: ese ~1 s todavía tenía ~350-450 ms de overhead propio del
 * CLI (serializar cada pregunta a stdin, que el CLI llame a la API, que
 * serialice la respuesta de vuelta por stdout, que este proceso la parsee).
 * Confirmado comparando el `ttft_ms` que reportaba el SDK contra una llamada
 * cruda a `api.anthropic.com` con el mismo modelo/prompt: la llamada cruda
 * bajaba a ~600-700 ms consistentemente.
 *
 * Este canal no necesita NADA de lo que paga ese overhead — sin tools, sin
 * lectura de archivos, sin permisos, sin orquestación — así que se salta el
 * CLI entero y llama a `/v1/messages` directo, con el mismo token OAuth que
 * ya usa `budget.ts` para leer el consumo. El historial de la charla (antes
 * lo llevaba el proceso vivo del SDK) ahora se lleva a mano, acotado para no
 * crecer sin límite.
 *
 * DOS VELOCIDADES (sin cambios de comportamiento)
 * Esta sesión va SIN TOOLS a propósito. Cuando la pregunta necesita mirar el
 * sistema de verdad, el modelo responde con el centinela CONSULTAR y quien
 * llama escala a un turno completo (con tools y sus pasos, vía chat-turns.ts
 * — ESE sí necesita el CLI/Agent SDK completo).
 */

import "../env.js";
import { readToken, refrescarTokenSiExpiro } from "../agent/budget.js";
import { OWNER } from "../owner.js";
import { contextoTemporal } from "../temporal.js";

/**
 * Prefijo con el que el modelo pide escalar porque la pregunta necesita el
 * sistema de verdad (archivos, proyectos, servidor). Lleva una descripción
 * corta detrás — "CONSULTAR: las carpetas del proyecto" — para poder
 * mostrarla YA como primer paso mientras el turno pesado (que tarda ~5s en
 * arrancar el CLI, ver el comentario grande de arriba) recién se prepara.
 * Sin esto, esos primeros segundos se veían como un loader genérico sin
 * decir nada — con esto, el usuario ve EN MILISEGUNDOS qué se está por
 * hacer, aunque la respuesta real tarde lo que tarde.
 */
export const CENTINELA = "CONSULTAR:";

/** Prefijo con el que la sesión rápida pide una imagen genérica (Pexafy). */
export const CENTINELA_IMAGEN = "IMAGEN:";

/**
 * Prefijo para una foto de alguien REAL identificable por nombre — va a
 * Wikipedia, no a Pexafy. Pexafy agrega bancos de fotos LIBRES (Unsplash,
 * Pexels, Pixabay...) que por licencia no incluyen gente real reconocible,
 * así que para "muéstrame a Shakira" siempre traía algo "relacionado"
 * (alguien cantando) y nunca a ella. Misma lógica que NOTICIA/DATO más
 * abajo: el clasificador ya entiende la intención, así que la ruta se
 * decide ahí en vez de adivinar después con una regex.
 */
export const CENTINELA_IMAGEN_PERSONA = "IMAGEN-PERSONA:";

/** "Esa no, otra": pide la siguiente imagen de la última búsqueda. */
export const CENTINELA_OTRA = "OTRA";

/**
 * "¿En qué quedaste?" / "¿qué estabas haciendo?" — preguntar por el estado
 * de la última escalada, en vez de dispararla nuevamente. Se contesta en
 * milisegundos porque NO abre un turno nuevo: `watch.ts` mira el turno que
 * ya tiene guardado (en memoria del proceso, `chatTurns.get`) y, si sigue
 * corriendo, engancha esta misma pregunta a seguirlo en vivo en vez de
 * dejarlo huérfano — nunca "no sé, pregunta de nuevo".
 */
export const CENTINELA_ESTADO = "ESTADO";

/**
 * Búsqueda EN INTERNET, camino rápido — mismo patrón que CENTINELA_IMAGEN:
 * se maneja EN LÍNEA en watch.ts (Tavily directo + un resumen de una frase
 * con este mismo modelo rápido), sin pasar por CONSULTAR/chat-turns.ts (un
 * turno completo con tools y sus pasos, mucho más lento). Antes "buscar en
 * internet" caía en CONSULTAR junto con archivos/memoria/proyectos — eso
 * pagaba el turno pesado por algo que ahora resuelve una llamada a Tavily
 * más un resumen, los dos en el canal ya optimizado a ~650-750ms.
 *
 * DOS variantes, no una — probado en vivo que hacía falta: Tavily tiene un
 * índice de "noticias" (prensa real y fechada) y uno "general" (todo lo
 * demás), y cuál conviene depende del TIPO de pregunta, no solo de si
 * necesita internet. "Noticias" le gana al general en resultados/cargos
 * recién cambiados (ahí el general trae SEO/apuestas viejas) — pero para
 * datos de referencia estables (calendario de feriados, lista de empresas)
 * el de noticias trae basura sin relación (para "días festivos de Chile"
 * devolvía noticias de MINERÍA porque eso es lo que suena de Chile esta
 * semana). Intentar adivinar esto con una lista de palabras clave en
 * watch.ts se quedaba corto cada vez que aparecía un caso nuevo — el
 * clasificador YA entiende la intención real, así que la decisión se le
 * pasa a él en vez de seguir agrandando una regex.
 */
export const CENTINELA_WEB_NOTICIA = "WEB-NOTICIA:";
export const CENTINELA_WEB_DATO = "WEB-DATO:";

const SISTEMA = `Eres OS, el asistente de ${OWNER}, respondiendo en la pantalla de un reloj.

Reglas, sin excepción:
- UNA sola frase, lo más corta posible. Sin markdown, sin listas, sin preámbulo.
- Si la respuesta es un dato, di solo el dato.
- Responde siempre en español.

- Nunca uses asteriscos, almohadillas ni guiones: en un reloj se ven como
  basura, no como formato.

Si te piden APUNTAR, guardar o recordar algo suelto ("apunta que...",
"recuérdame que...", "guarda esta idea"), responde únicamente:
IDEA: <la idea, redactada en una frase clara y completa>. Nada más. No lo
confundas con preguntas SOBRE lo ya guardado, que sí necesitan consultar.

Si te piden VER una imagen de una PERSONA REAL identificable por su nombre
(un famoso, un actor, un cantante, un deportista, un político, un personaje
histórico — alguien que tendría artículo propio en una enciclopedia, no un
desconocido genérico como "un señor" o "una mujer sonriendo"), responde
únicamente: ${CENTINELA_IMAGEN_PERSONA} <nombre completo, tal como se
titularía su artículo>. Nada más.

Si te piden VER una imagen de cualquier otra cosa (un animal, un objeto, un
lugar, una escena, "una foto bonita de X"), responde únicamente: IMAGEN:
<término>. Nada más.

El término debe ser CONCRETO y en singular, tal como se titularía un artículo
de enciclopedia: "husky siberiano", no "una foto bonita de un husky". Quita
los adjetivos de adorno y las palabras de la petición ("muéstrame", "una
imagen de"): con ellas dentro la búsqueda falla.

Si acabas de enseñar una imagen y el usuario dice que no era esa, que quiere
otra, o pide "la siguiente", responde únicamente: OTRA. Nada más — el sistema
recuerda qué se estaba buscando y trae la siguiente.

Si te preguntan por el estado de algo que te pidieron revisar antes ("¿en
qué quedaste?", "¿qué estabas haciendo?", "¿ya terminaste?", "¿cómo va
eso?"), responde ÚNICAMENTE con la palabra ${CENTINELA_ESTADO}. Nada más —
el sistema ya sabe de qué tarea se trata y dice si sigue corriendo o cómo
terminó, sin que vuelvas a dispararla.

Ya sabés la fecha, hora y lugar actuales — vienen más abajo, en otro bloque
de este mismo mensaje. Para "qué día es hoy", "qué hora es" o cualquier
variante, respondé DIRECTO con eso: nunca es un caso de ${CENTINELA_WEB_NOTICIA}
ni de ${CENTINELA_WEB_DATO}.

Si para responder necesitas algo de INTERNET que NO sea la fecha/hora/lugar
de arriba, NO lo intentes ni lo inventes: respondé con uno de estos DOS,
según de qué tipo sea — elegir mal el tipo trae resultados peores, así que
pensalo bien:

- ${CENTINELA_WEB_NOTICIA} <búsqueda> — para algo que depende de un EVENTO
  reciente: quién ganó algo, quién es el actual/nuevo presidente o cargo
  público, el resultado de una elección o un partido, un anuncio, "qué está
  pasando con X", un resumen de noticias. Si tu respuesta pudo haber
  cambiado por una noticia después de tu entrenamiento, es este.
- ${CENTINELA_WEB_DATO} <búsqueda> — para un dato de referencia o en vivo
  que NO depende de una noticia puntual: un precio, el clima, un calendario
  (feriados, horarios), una lista o ranking (empresas, países, productos),
  una cifra o estadística. Esto vive en páginas de referencia, no en
  artículos de prensa — pedir NOTICIA para esto trae resultados sin
  relación (probado: "días festivos de Chile" con NOTICIA devolvía
  noticias de minería, porque eso es lo que suena de Chile esa semana).

En cualquiera de los dos, nada más que eso — la búsqueda como se escribiría
en un buscador, SIN una fecha exacta escrita ("11 de septiembre de 2026"):
un buscador rara vez repite esa fecha textual en el resultado, así que
ponerla ahí empeora la búsqueda — "hoy" es una instrucción para quien
busca, no un término de búsqueda. Para "noticias de hoy en Colombia" la
búsqueda es "noticias Colombia", sin más.

IMPORTANTE sobre NOTICIA: tu entrenamiento tiene una fecha de corte, y ya
sabés que hoy es una fecha posterior a esa. Cualquier pregunta sobre un
resultado, ganador, elección, cargo público o evento que PUEDA haber
cambiado o sucedido después de tu entrenamiento es SIEMPRE ${CENTINELA_WEB_NOTICIA},
aunque "sientas" que ya sabés la respuesta — esa sensación es justo el
riesgo: tu memoria puede estar describiendo una versión vieja de algo que ya
cambió. Ante la duda de si tu conocimiento sigue vigente, buscá — no asumas
que "todavía no pasó" o que "sigue siendo" solo porque así era cuando
entrenaste.

Si para responder necesitas mirar archivos, memoria, proyectos, el servidor,
carpetas o ejecutar algo en la máquina, NO lo intentes ni lo inventes:
responde ÚNICAMENTE con ${CENTINELA} <qué vas a revisar, 2-5 palabras, SIN
verbo — "las carpetas del proyecto", "el estado del servidor", "los últimos
commits">. Nada de explicación ni de "voy a": eso y nada más. El usuario lo
ve EN EL ACTO como primer paso, mientras el sistema completo (que sí puede
mirar de verdad) arma la respuesta real por detrás.`;

/**
 * Lo que se le añade al turno COMPLETO cuando la vía rápida escala.
 *
 * Sin esto el turno completo responde con el estilo normal del agente —
 * párrafos, listas y markdown— porque el prompt de brevedad vive en la sesión
 * rápida y la escalada no lo hereda. Ese era el motivo de que justo las
 * respuestas escaladas salieran largas.
 */
export const ESTILO_ESCALADA = `Responde para la pantalla de un reloj: frases
CORTAS, en español, sin markdown, sin asteriscos, sin listas ni encabezados.
La CONCLUSIÓN final va en una sola frase. Si la respuesta es un dato, di solo
el dato.

Podés ir comentando brevemente a medida que investigás (una frase por
comentario, nunca un párrafo) — el reloj muestra cada comentario tuyo por
separado, intercalado con lo que vas ejecutando, así que se lee como ir
contando lo que hacés, no como narrar de más. Lo único que no debe pasar es
un preámbulo largo antes de arrancar.

Si necesitás mirar varias cosas INDEPENDIENTES entre sí (dos carpetas
distintas, el estado del servidor Y la lista de proyectos, varios archivos
sueltos), pedilas TODAS en la misma respuesta en vez de una por una: las
herramientas de solo lectura corren en paralelo cuando se piden juntas, y
pedirlas de a una multiplica la espera sin necesidad.

NUNCA cites fuentes, enlaces, dominios ni "según X". En una pantalla de reloj
la fuente ocupa más que la respuesta y no se puede pinchar. Da el hecho y
punto.`;

/**
 * TODOS los centinelas. Se usa para no streamear ninguno a la pantalla.
 *
 * `CENTINELA_IDEA` vive en intenciones.ts, pero la lista tiene que estar
 * completa aquí: cuando se añadió IDEA: y no se apuntó en este filtro, la
 * palabra "IDEA:" salió impresa en el reloj.
 */
const CENTINELAS = [
  CENTINELA,
  CENTINELA_IMAGEN,
  CENTINELA_IMAGEN_PERSONA,
  CENTINELA_WEB_NOTICIA,
  CENTINELA_WEB_DATO,
  CENTINELA_ESTADO,
  "IDEA:",
  "OTRA",
];

/** IDs completos, no alias del CLI: la API cruda no resuelve "haiku". */
const MODELO = process.env.WATCH_MODEL || "claude-haiku-4-5-20251001";

/** Tope del historial que se manda en cada llamada (mensajes, no turnos). */
const HISTORIAL_MAX = 24;

type Mensaje = { role: "user" | "assistant"; content: string };
type BloqueTexto = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type MensajeAPI = { role: "user" | "assistant"; content: string | BloqueTexto[] };

class SesionRapida {
  private historial: Mensaje[] = [];
  /** Cuántos turnos van en lo que llevamos — sube con cada respuesta. */
  private turnos = 0;
  /** Notas de `anotar()` sin entregar: se pegan delante de la próxima pregunta. */
  private notas: string[] = [];
  /**
   * Mutex simple: sin proceso propio que serialice, dos `preguntar()`
   * concurrentes (dos pestañas, un doble tap) podrían leer/escribir
   * `historial` en cualquier orden. Encadenar por esta promesa basta —
   * ya no hace falta la cola FIFO con correlación por turno de la versión
   * con el SDK, porque cada llamada es un request HTTP autocontenido.
   */
  private cadena: Promise<unknown> = Promise.resolve();

  /**
   * Ya no hay proceso que arrancar en frío: cada pregunta es un POST directo,
   * sin subproceso de por medio. Se deja el método (index.ts lo llama al
   * arrancar) para no tocar ese call site por algo que ya no hace nada.
   */
  calentar(): void {}

  /**
   * Le cuenta a la sesión rápida algo que pasó FUERA de ella (una idea
   * guardada, una escalada que terminó) para que la próxima pregunta real
   * tenga ese contexto. Solo se guarda en memoria — cero llamadas al modelo
   * — y se pega delante del PRÓXIMO prompt real en `preguntar()`.
   */
  anotar(resumen: string): void {
    this.notas.push(resumen);
  }

  /**
   * Notas pendientes + el último intercambio de esta sesión, en texto —
   * para pasárselo a la escalada completa (CONSULTAR/`chat-turns.ts`), que
   * es una sesión APARTE sin acceso a este historial.
   *
   * Bug real que arregla: la nota SÍ llega a la CLASIFICACIÓN (viaja pegada
   * al mensaje dentro de `preguntar()`), así que el modelo rápido decide
   * escalar viendo el contexto — pero la escalada arma su propio prompt
   * desde el mensaje pelado, sin ese contexto. "Profundiza en eso" escalaba
   * y el turno completo no tenía ni idea de qué era "eso".
   *
   * CONSUME las notas pendientes (igual que haría `preguntar()`) para que no
   * se repitan de más en la próxima pregunta rápida después de escalar.
   */
  tomarContextoReciente(): string {
    const partes: string[] = this.notas.map((n) => `[contexto: ${n}]`);
    this.notas = [];
    const ultimo = this.historial.slice(-2);
    if (ultimo.length) {
      partes.push(ultimo.map((m) => `${m.role === "user" ? "Usuario" : "OS"}: ${m.content}`).join("\n"));
    }
    return partes.join("\n");
  }

  preguntar(prompt: string, onDelta: (t: string) => void): Promise<string> {
    const conNotas = this.notas.length
      ? `${this.notas.map((n) => `[contexto: ${n}]`).join("\n")}\n\n${prompt}`
      : prompt;
    this.notas = [];
    const tarea = this.cadena.then(() => this.llamar(conNotas, onDelta));
    // No propagar el rechazo de ESTA llamada a la siguiente en la cadena.
    this.cadena = tarea.then(
      () => undefined,
      () => undefined,
    );
    return tarea;
  }

  private async llamar(
    prompt: string,
    onDelta: (t: string) => void,
    reintento = false,
  ): Promise<string> {
    const t0 = Date.now();
    const token = await readToken();
    if (!token) {
      const msg = "No tengo credenciales para responder ahora mismo.";
      onDelta(msg);
      return msg;
    }

    // Punto de corte del caché: TODO lo anterior a la pregunta nueva (system +
    // historial) es el mismo prefijo exacto que ya se mandó la vez pasada, así
    // que se marca como cacheable — Anthropic solo reprocesa lo que cambió
    // (la pregunta nueva), no la conversación entera desde cero en cada
    // llamada. Sin mínimo de tokens no cachea nada (silencioso, no falla), así
    // que al principio de una sesión esto no hace nada — empieza a notarse
    // según crece el historial.
    const previos: MensajeAPI[] = this.historial.map((m) => ({ role: m.role, content: m.content }));
    if (previos.length > 0) {
      const ultimo = previos[previos.length - 1];
      previos[previos.length - 1] = {
        role: ultimo.role,
        content: [{ type: "text", text: ultimo.content as string, cache_control: { type: "ephemeral" } }],
      };
    }
    const mensajes: MensajeAPI[] = [...previos, { role: "user", content: prompt }];

    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODELO,
          max_tokens: 300,
          stream: true,
          // Segundo bloque de system, SIN cache_control: la fecha/hora cambia
          // en cada llamada, así que va después del prefijo cacheable en vez
          // de mezclada con SISTEMA (eso tiraría el caché byte a byte).
          system: [
            { type: "text", text: SISTEMA, cache_control: { type: "ephemeral" } },
            { type: "text", text: contextoTemporal() },
          ],
          messages: mensajes,
        }),
      });
    } catch (err) {
      console.error("[reloj] llamada falló:", err);
      const msg = "Algo falló de mi lado, intenta de nuevo.";
      onDelta(msg);
      return msg;
    }

    if (!res.ok || !res.body) {
      const cuerpo = await res.text?.().catch(() => "");
      console.error(`[reloj] llamada falló: ${res.status} ${cuerpo ?? ""}`);
      // 401 con token vencido: se refresca vía el CLI real (ver
      // refrescarTokenSiExpiro) y se reintenta ESTA MISMA pregunta una vez
      // — sin esto, el reloj se queda sirviendo "algo falló de mi lado"
      // durante horas hasta que alguien abra el chat principal y lo
      // refresque de pura casualidad.
      if (res.status === 401 && !reintento) {
        console.log("[reloj] token vencido, forzando refresh vía CLI…");
        await refrescarTokenSiExpiro();
        return this.llamar(prompt, onDelta, true);
      }
      const msg = "Algo falló de mi lado, intenta de nuevo.";
      onDelta(msg);
      return msg;
    }

    let buf = "";
    let acumulado = "";
    // Cuánto de `acumulado` ya se mandó por `onDelta` — ver el flush de más
    // abajo.
    let entregado = 0;
    let primerDeltaEn: number | null = null;
    // Del `message_start`: cuánto del prefijo se sirvió de caché vs. de cero.
    // Es la única forma de CONFIRMAR que el cache_control de arriba hace algo
    // en vez de asumirlo.
    let cacheLectura = 0;
    let cacheEscritura = 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        // Los eventos SSE vienen separados por una línea en blanco.
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const bloque = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = bloque.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let evento: {
            type?: string;
            delta?: { type?: string; text?: string };
            message?: { usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
          };
          try {
            evento = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (evento.type === "message_start") {
            cacheLectura = evento.message?.usage?.cache_read_input_tokens ?? 0;
            cacheEscritura = evento.message?.usage?.cache_creation_input_tokens ?? 0;
          } else if (
            evento.type === "content_block_delta" &&
            evento.delta?.type === "text_delta" &&
            evento.delta.text
          ) {
            if (primerDeltaEn == null) primerDeltaEn = Date.now();
            acumulado += evento.delta.text;
            const parcial = acumulado.trim();
            // Ningún centinela se streamea: si la respuesta empieza por uno,
            // esas palabras no deben aparecer en la muñeca.
            const esCentinela = CENTINELAS.some((c) => c.startsWith(parcial) || parcial.startsWith(c));
            // Mientras podría SER un centinela, no se manda nada — pero eso
            // retiene texto real (ej. "C" de "Canberra", porque "CONSULTAR"
            // también empieza por C). En cuanto se confirma que NO lo es, hay
            // que mandar TODO lo retenido de una — mandar solo el delta de
            // ESTA vuelta perdía esos primeros caracteres para siempre (bug
            // real: "Canberra" llegaba como "anberra").
            if (!esCentinela && entregado < acumulado.length) {
              onDelta(acumulado.slice(entregado));
              entregado = acumulado.length;
            }
          }
        }
      }
    } catch (err) {
      console.error("[reloj] stream cortado:", err);
    }

    const texto = acumulado.trim();
    this.historial.push({ role: "user", content: prompt }, { role: "assistant", content: texto });
    if (this.historial.length > HISTORIAL_MAX) this.historial = this.historial.slice(-HISTORIAL_MAX);

    this.turnos += 1;
    const total = Date.now() - t0;
    const ttft = primerDeltaEn != null ? primerDeltaEn - t0 : null;
    console.log(
      `[reloj] ttft=${ttft ?? "?"}ms total=${total}ms turno=${this.turnos} cache_lectura=${cacheLectura} cache_escritura=${cacheEscritura}`,
    );

    return texto;
  }
}

export const relojRapido = new SesionRapida();
