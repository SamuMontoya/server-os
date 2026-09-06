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
import { readToken } from "../agent/budget.js";
import { OWNER } from "../owner.js";

/** El modelo responde EXACTAMENTE esto cuando la pregunta necesita el sistema. */
export const CENTINELA = "CONSULTAR";

/** Prefijo con el que la sesión rápida pide una imagen. */
export const CENTINELA_IMAGEN = "IMAGEN:";

/** "Esa no, otra": pide la siguiente imagen de la última búsqueda. */
export const CENTINELA_OTRA = "OTRA";

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

Si te piden VER una imagen de algo ("muéstrame un husky", "enséñame una foto
de X"), responde únicamente: IMAGEN: <término>. Nada más.

El término debe ser CONCRETO y en singular, tal como se titularía un artículo
de enciclopedia: "husky siberiano", no "una foto bonita de un husky". Quita
los adjetivos de adorno y las palabras de la petición ("muéstrame", "una
imagen de"): con ellas dentro la búsqueda falla.

Si acabas de enseñar una imagen y el usuario dice que no era esa, que quiere
otra, o pide "la siguiente", responde únicamente: OTRA. Nada más — el sistema
recuerda qué se estaba buscando y trae la siguiente.

Si para responder necesitas mirar archivos, memoria, proyectos, el calendario,
BUSCAR EN INTERNET o ejecutar algo en la máquina, NO lo intentes ni lo
inventes y NO lo anuncies:
responde únicamente con la palabra ${CENTINELA} y nada más. Ni una frase
antes, ni una explicación, ni "voy a revisar". Solo esa palabra. Otro sistema
se encargará y el usuario verá lo que se está haciendo.`;

/**
 * Lo que se le añade al turno COMPLETO cuando la vía rápida escala.
 *
 * Sin esto el turno completo responde con el estilo normal del agente —
 * párrafos, listas y markdown— porque el prompt de brevedad vive en la sesión
 * rápida y la escalada no lo hereda. Ese era el motivo de que justo las
 * respuestas escaladas salieran largas.
 */
export const ESTILO_ESCALADA = `Responde para la pantalla de un reloj: UNA sola
frase corta con la conclusión, en español. Sin markdown, sin asteriscos, sin
listas, sin encabezados, sin preámbulo y sin narrar lo que vas a hacer — el
usuario ya está viendo los pasos. Si la respuesta es un dato, di solo el dato.

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
const CENTINELAS = [CENTINELA, CENTINELA_IMAGEN, "IDEA:", "OTRA"];

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

  private async llamar(prompt: string, onDelta: (t: string) => void): Promise<string> {
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
          system: [{ type: "text", text: SISTEMA, cache_control: { type: "ephemeral" } }],
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
      const msg = "Algo falló de mi lado, intenta de nuevo.";
      onDelta(msg);
      return msg;
    }

    let buf = "";
    let acumulado = "";
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
            if (!esCentinela) onDelta(evento.delta.text);
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
