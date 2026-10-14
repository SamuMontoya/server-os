import { query } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../env.js";

/**
 * Desborde de contexto: el historial de la sesión ya no cabe en la ventana del
 * modelo con que se la quiere reanudar.
 *
 * La API lo entrega como un mensaje de asistente SINTÉTICO ("Prompt is too
 * long"), y el CLI lo reenvía como un `result` con `is_error`. Sin reconocerlo
 * por separado caía en `api_error`, que chat-turns.ts trata como transitorio
 * (429/529): reintentaba tres veces lo mismo, que es determinista, y cerraba
 * con el texto crudo en inglés.
 */
export function esDesbordeDeContexto(texto: string | undefined | null): boolean {
  return /prompt is too long|conversation too long/i.test(texto ?? "");
}

export interface CompactResult {
  ok: boolean;
  /** Tokens del contexto antes y después, si el CLI los reportó. */
  antes?: number;
  despues?: number;
  error?: string;
}

/** Compactar una sesión de ~600k tokens tardó 46 s; el tope deja margen. */
const COMPACT_TIMEOUT_MS = 180_000;

/**
 * Compacta una sesión del SDK: el CLI resume el historial viejo y conserva lo
 * reciente, y la sesión sigue siendo la misma (mismo id) — el siguiente
 * `resume` ya la encuentra más chica.
 *
 * Corre con sonnet a propósito y no con el nivel del turno: resumir cientos de
 * miles de tokens con haiku es justo el caso en que no cabe, y el desborde que
 * se está arreglando casi siempre viene de haber reanudado con un modelo de
 * ventana chica.
 *
 * `cwd` TIENE que ser el mismo con que corrió la sesión: el CLI guarda cada
 * sesión bajo una carpeta derivada del cwd, y desde otro no la encuentra.
 */
export async function compactarSesion(input: {
  sessionId: string;
  cwd?: string;
  abortController?: AbortController;
}): Promise<CompactResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), COMPACT_TIMEOUT_MS);
  const onAbortExterno = () => abort.abort();
  input.abortController?.signal.addEventListener("abort", onAbortExterno);

  let antes: number | undefined;
  let despues: number | undefined;
  let compactado = false;
  let fallo: string | undefined;

  try {
    const q = query({
      prompt:
        "/compact Conserva el objetivo de la tarea en curso, lo ya hecho, las decisiones tomadas y lo que falta por hacer.",
      options: {
        cwd: input.cwd || env.VAULT_PATH || process.cwd(),
        model: "sonnet",
        resume: input.sessionId,
        maxTurns: 3,
        settingSources: [],
        permissionMode: "default",
        abortController: abort,
      },
    });
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "compact_boundary") {
        compactado = true;
        antes = m.compact_metadata?.pre_tokens;
        despues = m.compact_metadata?.post_tokens;
      }
      if (m.type === "result") {
        if (m.subtype === "success") {
          if (m.is_error) fallo = m.result || "el CLI devolvió un error";
        } else {
          fallo = m.errors?.join("; ") || String(m.subtype);
        }
      }
    }
  } catch (err) {
    fallo = fallo ?? (err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    input.abortController?.signal.removeEventListener("abort", onAbortExterno);
  }

  return compactado && !fallo
    ? { ok: true, antes, despues }
    : { ok: false, antes, despues, error: fallo ?? "el CLI no reportó una compactación" };
}
