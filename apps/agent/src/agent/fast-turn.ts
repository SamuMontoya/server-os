/**
 * Vía rápida del chat principal — el mismo protocolo que ya usa el reloj
 * (watch/rapido.ts), aplicado a /laboratorio.
 *
 * Por qué: el nivel "trivial" del router (charla, preguntas de estado, sin
 * señal de código/orquestación) casi nunca necesita herramientas, pero HOY
 * paga igual el arranque completo del proceso `claude` — medido en vivo, 8.2s
 * para titular un chat, una tarea mucho más chica que responder de verdad.
 * Acá se intenta primero una respuesta directa a la API (sin CLI/Agent SDK):
 * si el modelo decide que SÍ necesita herramientas (archivos, bash, memoria,
 * vault, web — cualquier cosa real), responde con el centinela HERRAMIENTAS
 * y quien llama (session.ts) cae al motor completo con el MISMO prompt. El
 * usuario no ve la diferencia salvo en la velocidad de lo que sí se resuelve
 * rápido.
 *
 * System prompt DELIBERADAMENTE minimalista y sin mencionar ninguna tool por
 * nombre — NO reusa buildSystemPrompt(). Primera versión sí lo reusaba (con
 * su párrafo "Tools mcp__hermes__*: search_knowledge…") y en producción el
 * modelo, al no tener una tool real que llamar, en vez de emitir el centinela
 * ESCRIBIÓ una pseudo-llamada (`<search_knowledge>…</search_knowledge>`) y
 * FABRICÓ una respuesta de "proyectos activos" con datos inventados — nunca
 * tocó un dato real. Vocabulario de tools en el prompt = vocabulario que el
 * modelo puede imitar sin tener la tool. Este prompt no le da ese vocabulario:
 * si necesita cualquier cosa del sistema real, la única salida válida es la
 * palabra HERRAMIENTAS sola. `stop_sequences` es el freno estructural por si
 * igual lo intenta: corta ANTES de que la fabricación llegue a la pantalla.
 *
 * Historial: esta vía no toca el SDK, así que no hay sesión que la mantenga
 * viva entre mensajes de un mismo hilo. Se guarda un historial chico propio
 * por sesión (mismo patrón que watch/rapido.ts) para que la charla tenga
 * continuidad, y para pasarle un recap al motor completo si el hilo termina
 * escalando (que arranca su PROPIA sesión SDK desde cero, sin haber visto lo
 * que ya se conversó por acá).
 */
import { readToken, refrescarTokenSiExpiro } from "./budget.js";
import { contextoTemporal } from "../temporal.js";
import { OWNER } from "../owner.js";

const MODELO = process.env.WATCH_MODEL || "claude-haiku-4-5-20251001";
const CENTINELA = "HERRAMIENTAS";
const HISTORIAL_MAX = 16;
const MAX_SESIONES = 500;

/**
 * Nombres reales de las tools mcp__hermes__* (agent/tools.ts) SIN el prefijo,
 * como `<nombre` — freno estructural: si el modelo escribe el inicio de una
 * pseudo-llamada a cualquiera de estas, la API corta ahí mismo. A propósito
 * una lista a mano y no un import de tools.ts: esta vía es deliberadamente
 * independiente del SDK/las tools reales, y la lista cambia poco.
 */
const STOP_SEQUENCES = [
  "<search_knowledge",
  "<save_memory",
  "<search_memory",
  "<save_preference",
  "<get_project_status",
  "<update_project_note",
  "<search_vault",
  "<capture_idea",
  "<web_search",
  "<image_search",
  "<get_recent_activity",
];

const SISTEMA_BASE = `Eres OS, el asistente de ${OWNER}. Estás respondiendo un mensaje de chat de texto (no de voz), en español informal, de tú, directo. Por defecto corto — te alargas solo si la pregunta de verdad lo pide.

En ESTE mensaje puntual no tenés acceso a NADA del sistema real: nada de archivos, memoria guardada, vault, estado de proyectos, ejecutar algo, ni internet en vivo. Es una respuesta directa, solo de tu conocimiento general y de lo ya conversado en este chat — nada más.

Si la pregunta es charla, algo que ya sabés de memoria, o una continuación de esta misma charla: respondé normal, directo.

Si para responder de VERDAD necesitás cualquier cosa de arriba —estado real de un proyecto, un archivo, algo guardado antes, ejecutar algo en el servidor, un dato en vivo de internet, cualquier hecho que no tengas ya en esta charla—: NO lo inventes ni improvises algo que "suene razonable". Respondé ÚNICAMENTE con la palabra ${CENTINELA}, sin nada antes ni después, sin explicar por qué. Nunca escribas el nombre de una herramienta ni una llamada simulada (nada entre <> ni \`\`\` que parezca invocar algo) — no tenés ninguna activa ahora mismo, escribir eso no ejecuta nada real, solo confunde. La única salida válida cuando hace falta algo real es esa palabra sola.`;

interface Turno {
  role: "user" | "assistant";
  content: string;
}

const historiales = new Map<string, Turno[]>();

function historialDe(key: string | undefined): Turno[] {
  return key ? (historiales.get(key) ?? []) : [];
}

function agregar(key: string, turno: Turno): void {
  const h = historiales.get(key) ?? [];
  h.push(turno);
  if (h.length > HISTORIAL_MAX) h.splice(0, h.length - HISTORIAL_MAX);
  if (!historiales.has(key) && historiales.size >= MAX_SESIONES) {
    historiales.delete(historiales.keys().next().value as string);
  }
  historiales.set(key, h);
}

/**
 * Recap de lo ya conversado por la vía rápida, para cuando el hilo escala:
 * el motor completo arranca una sesión SDK nueva y no vio nada de esto.
 */
export function recapEscalada(sessionKey: string | undefined): string {
  const h = historialDe(sessionKey);
  if (!h.length) return "";
  const texto = h.map((t) => `${t.role === "user" ? "Usuario" : "OS"}: ${t.content}`).join("\n");
  return `[Contexto de lo ya conversado en este hilo, por la vía rápida sin herramientas:]\n${texto}\n\n`;
}

interface IntentoInput {
  sessionKey?: string;
  mensaje: string;
  onDelta: (text: string) => void;
  /** ⏹ Detener. Un abort NO es "hay que escalar" — hay que cortar de verdad,
   *  así que esto SE LANZA (no devuelve false) para que chat-turns.ts lo trate
   *  igual que cualquier otro abort del motor pesado. */
  signal?: AbortSignal;
}

/**
 * true = respondió directo (ya emitió todo por onDelta, no hace falta nada
 * más). false = hay que caer al motor completo (el modelo pidió escalar, el
 * freno de `stop_sequences` cortó una fabricación antes de mostrarla, o la
 * llamada directa falló por cualquier motivo — fallar abierto a la vía ya
 * probada, nunca mostrar un error ni datos inventados por esto). Lanza si
 * `signal` ya estaba o se activó durante la llamada — ver el comentario de
 * `signal` arriba.
 */
export async function intentarViaRapida(input: IntentoInput, reintento = false): Promise<boolean> {
  if (input.signal?.aborted) throw new DOMException("Turno detenido", "AbortError");
  const token = await readToken();
  if (!token) return false;

  const previos: { role: string; content: unknown }[] = historialDe(input.sessionKey).map((t) => ({
    role: t.role,
    content: t.content,
  }));
  if (previos.length > 0) {
    const ultimo = previos[previos.length - 1];
    previos[previos.length - 1] = {
      role: ultimo.role,
      content: [{ type: "text", text: ultimo.content, cache_control: { type: "ephemeral" } }],
    };
  }

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
        max_tokens: 1024,
        stream: true,
        stop_sequences: STOP_SEQUENCES,
        // Segundo bloque SIN cache_control (temporal, cambia cada llamada) —
        // mismo motivo que watch/rapido.ts: mezclarlo con el system cacheable
        // tiraría el prefijo entero en cada llamada.
        system: [
          { type: "text", text: SISTEMA_BASE, cache_control: { type: "ephemeral" } },
          { type: "text", text: contextoTemporal() },
        ],
        messages: [...previos, { role: "user", content: input.mensaje }],
      }),
      signal: input.signal,
    });
  } catch (err) {
    if (input.signal?.aborted) throw err;
    console.error("[fast-turn] llamada falló:", err);
    return false;
  }

  if (!res.ok || !res.body) {
    if (res.status === 401 && !reintento) {
      await refrescarTokenSiExpiro();
      return intentarViaRapida(input, true);
    }
    console.error(`[fast-turn] ${res.status} ${await res.text().catch(() => "")}`);
    return false;
  }

  // SSE manual, igual que watch/rapido.ts: se retiene texto mientras PODRÍA
  // ser el prefijo del centinela, para que "HERRAMIENTAS" nunca se filtre a
  // medio escribir en la pantalla.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acumulado = "";
  let entregado = 0;
  let escalar = false;
  let cortadoPorStop = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lineas = buffer.split("\n");
      buffer = lineas.pop() ?? "";
      for (const linea of lineas) {
        if (!linea.startsWith("data: ")) continue;
        let evt: {
          type?: string;
          delta?: { type?: string; text?: string; stop_reason?: string };
        };
        try {
          evt = JSON.parse(linea.slice(6));
        } catch {
          continue;
        }
        if (evt.type === "message_delta" && evt.delta?.stop_reason === "stop_sequence") {
          cortadoPorStop = true;
          escalar = true;
          break;
        }
        if (evt.type !== "content_block_delta" || evt.delta?.type !== "text_delta") continue;
        acumulado += evt.delta.text ?? "";
        const parcial = acumulado.trim();
        if (parcial.startsWith(CENTINELA)) {
          escalar = true;
          break;
        }
        const podriaSerCentinela = CENTINELA.startsWith(parcial);
        if (!podriaSerCentinela && entregado < acumulado.length) {
          input.onDelta(acumulado.slice(entregado));
          entregado = acumulado.length;
        }
      }
      if (escalar) break;
    }
  } catch (err) {
    // Abortar el fetch también corta el body stream — un ⏹ Detener llega acá,
    // no como error de red. Se relanza (no `return true/false`) para que
    // chat-turns.ts lo cierre como "stopped", igual que el motor pesado.
    if (input.signal?.aborted) throw err;
    console.error("[fast-turn] stream falló:", err);
    if (entregado > 0) return true;
    return false;
  } finally {
    void reader.cancel().catch(() => {});
  }

  if (escalar) {
    // El freno de stop_sequence pudo haber disparado DESPUÉS de que algo ya
    // se mostrara (ej. un preámbulo antes del intento de tool falsa) — ahí ya
    // no hay forma limpia de escalar sin duplicar: se corta tal cual quedó,
    // mejor un mensaje truncado que uno fabricado completo.
    if (cortadoPorStop && entregado > 0) return true;
    return false;
  }

  const textoFinal = acumulado.trim();
  if (!textoFinal || textoFinal.startsWith(CENTINELA)) return false;

  if (entregado < acumulado.length) input.onDelta(acumulado.slice(entregado));

  if (input.sessionKey) {
    agregar(input.sessionKey, { role: "user", content: input.mensaje });
    agregar(input.sessionKey, { role: "assistant", content: acumulado });
  }
  return true;
}
