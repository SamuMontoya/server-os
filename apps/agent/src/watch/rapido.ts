/**
 * Canal RÁPIDO del reloj: una sesión persistente del Agent SDK.
 *
 * POR QUÉ EXISTE
 * Un turno normal tarda ~5 s en decir la primera palabra, y medido resulta que
 * casi todo es arrancar el proceso del CLI del SDK — no el modelo (cambiar
 * sonnet por haiku movió la aguja 0,4 s) ni el prompt. En una muñeca eso se
 * lee como una app colgada.
 *
 * Aquí el proceso queda VIVO: se paga el arranque una sola vez (warm-up) y
 * cada pregunta cuesta solo lo que tarde el modelo en hablar. Es el mismo
 * patrón que ya usa el copiloto de juntas (meetings/live-copilot.ts), que
 * nació del mismo problema.
 *
 * DOS VELOCIDADES
 * Esta sesión va SIN TOOLS a propósito: las tools obligan a round-trips y a
 * un prompt de sistema grande, que es justo lo que se quiere evitar. Cuando la
 * pregunta necesita mirar el sistema de verdad, el modelo responde con el
 * centinela CONSULTAR y quien llama escala a un turno completo (con tools y
 * sus pasos). Así la charla es instantánea y solo se paga el camino lento
 * cuando hace falta de verdad.
 */

import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../env.js";
import { OWNER } from "../owner.js";

/** El modelo responde EXACTAMENTE esto cuando la pregunta necesita el sistema. */
export const CENTINELA = "CONSULTAR";

/** Prefijo con el que la sesión rápida pide una imagen. */
export const CENTINELA_IMAGEN = "IMAGEN:";

const SISTEMA = `Eres Hermes, el asistente de ${OWNER}, respondiendo en la pantalla de un reloj.

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

interface Pendiente {
  prompt: string;
  onDelta: (t: string) => void;
  resolver: (texto: string) => void;
  buf: string;
  entregado: boolean;
  silencioso: boolean;
}

class SesionRapida {
  private q: Query | null = null;
  private cola: Pendiente[] = [];
  /** Turnos ya entregados al SDK, en orden: la correlación es FIFO estricta. */
  private vivos: Pendiente[] = [];
  private despertar: (() => void) | null = null;
  private cerrada = false;

  /** Arranca el proceso y paga el coste una vez, antes de la primera pregunta real. */
  calentar(): void {
    this.asegurar();
    this.encolar({ prompt: "Responde únicamente: OK", silencioso: true });
  }

  /**
   * Le cuenta a la sesión rápida algo que pasó FUERA de ella.
   *
   * Cuando un turno escalado responde, esa respuesta no existe para la sesión
   * rápida: es otro proceso. Sin esto, preguntar "¿y eso por qué?" justo
   * después de una consulta escalada recibiría un "¿a qué te refieres?", que
   * en una conversación de muñeca se siente roto. Va como turno silencioso:
   * ocupa su sitio en la cola (la correlación es FIFO) pero no emite nada.
   */
  anotar(_resumen: string): void {
    this.asegurar();
    this.encolar({
      prompt: `[contexto, no respondas nada más que OK] ${_resumen}`,
      silencioso: true,
    });
  }

  preguntar(prompt: string, onDelta: (t: string) => void): Promise<string> {
    this.asegurar();
    return new Promise((resolver) => {
      this.encolar({ prompt, onDelta, resolver });
    });
  }

  private encolar(p: {
    prompt: string;
    onDelta?: (t: string) => void;
    resolver?: (t: string) => void;
    silencioso?: boolean;
  }): void {
    this.cola.push({
      prompt: p.prompt,
      onDelta: p.onDelta ?? (() => {}),
      resolver: p.resolver ?? (() => {}),
      buf: "",
      entregado: false,
      silencioso: p.silencioso ?? false,
    });
    this.despertar?.();
  }

  private asegurar(): void {
    if (this.q || this.cerrada) return;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    async function* entrada(): AsyncGenerator<SDKUserMessage> {
      while (!self.cerrada) {
        const p = self.cola.shift();
        if (p) {
          self.vivos.push(p);
          yield {
            type: "user",
            message: { role: "user", content: p.prompt },
            parent_tool_use_id: null,
          } as SDKUserMessage;
          continue;
        }
        await new Promise<void>((r) => {
          self.despertar = r;
        });
        self.despertar = null;
      }
    }

    this.q = query({
      prompt: entrada(),
      options: {
        cwd: env.VAULT_PATH || process.cwd(),
        systemPrompt: SISTEMA,
        // Configurable para poder MEDIR el cambio, no suponerlo: con el
        // proceso ya vivo el tiempo hasta la primera palabra es casi todo del
        // modelo, así que aquí sí se nota cuál se use.
        model: process.env.WATCH_MODEL || "haiku",
        includePartialMessages: true,
        // Aquí manda el tiempo hasta la primera palabra: el razonamiento
        // previo lo estropea y para una frase corta no aporta nada.
        thinking: { type: "disabled" },
        maxTurns: 1000, // la sesión vive todo lo que viva el proceso
        settingSources: [],
        tools: [], // sin tools: texto plano directo, sin round-trips
        permissionMode: "default",
      },
    });
    void this.consumir(this.q);
  }

  private async consumir(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if (this.cerrada) break;

        if (msg.type === "stream_event") {
          const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            const actual = this.vivos[0];
            if (actual) {
              actual.buf += ev.delta.text;
              // El centinela no se streamea: si la respuesta empieza por él,
              // el reloj no debe ver aparecer la palabra CONSULTAR en pantalla.
              // Ni el centinela ni el de imagen se streamean: si la respuesta
              // empieza por uno, esas palabras no deben aparecer en la muñeca.
              const parcial = actual.buf.trim()
              const esCentinela =
                CENTINELA.startsWith(parcial) || CENTINELA_IMAGEN.startsWith(parcial) ||
                parcial.startsWith(CENTINELA_IMAGEN)
              if (!esCentinela && !actual.silencioso) {
                actual.onDelta(ev.delta.text);
              }
            }
          }
        } else if (msg.type === "result") {
          // El `result` CIERRA el turno más viejo, incluso si vino sin
          // mensaje del asistente (interrumpido). Sin esto la correlación
          // FIFO se desalinea y cada respuesta sale contestando a la
          // pregunta anterior.
          const p = this.vivos.shift();
          if (p && !p.entregado) {
            p.entregado = true;
            p.resolver(p.buf.trim());
          }
          const r = msg as { ttft_ms?: number; duration_ms?: number };
          if (r.ttft_ms != null) {
            console.log(`[reloj] ttft=${r.ttft_ms}ms total=${r.duration_ms ?? "?"}ms`);
          }
        }
      }
    } catch (err) {
      console.error("[reloj] sesión caída:", err);
    } finally {
      // Que se caiga no puede dejar peticiones colgadas para siempre.
      for (const p of this.vivos) if (!p.entregado) { p.entregado = true; p.resolver(p.buf.trim()); }
      this.vivos = [];
      this.q = null;
      // La siguiente pregunta reconstruye la sesión (y paga el arranque otra vez).
    }
  }
}

export const relojRapido = new SesionRapida();
