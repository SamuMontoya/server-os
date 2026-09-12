/**
 * Completado de una sola pasada, SIN tools, sin pasar por el Agent SDK/CLI.
 *
 * Por qué existe: `query()` del SDK arranca un proceso `claude` completo por
 * llamada — medido en producción, un chatTitle (3 palabras de salida) tardó
 * 8.2s, y ese proceso compite por CPU con el turno real en la misma máquina.
 * El canal del reloj (`watch/rapido.ts`) ya resolvió esto para sus propias
 * llamadas yendo directo a `/v1/messages` con el token OAuth de la sesión de
 * Claude Code; esto es lo mismo, extraído para que cualquier rol de una sola
 * pasada sin herramientas (chatTitle, chatGist) lo reuse.
 */
import { readToken, refrescarTokenSiExpiro } from "./budget.js";

const HAIKU_MODEL = process.env.WATCH_MODEL || "claude-haiku-4-5-20251001";

export async function completarDirecto(
  system: string,
  prompt: string,
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
  reintento = false,
): Promise<string> {
  if (opts.signal?.aborted) return "";
  const token = await readToken();
  if (!token) return "";

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
        model: HAIKU_MODEL,
        max_tokens: opts.maxTokens ?? 200,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: opts.signal,
    });
  } catch (err) {
    // Un abort explícito (⏹ Detener) llega acá como AbortError — no es una
    // falla de red real, no tiene sentido loguearla como tal.
    if (opts.signal?.aborted) return "";
    console.error("[direct-complete] llamada falló:", err);
    return "";
  }

  if (!res.ok) {
    // Mismo motivo que rapido.ts: un token OAuth vencido se refresca vía el
    // CLI real (única fuente de verdad de ese flujo) y se reintenta una vez.
    if (res.status === 401 && !reintento) {
      await refrescarTokenSiExpiro();
      return completarDirecto(system, prompt, opts, true);
    }
    console.error(`[direct-complete] ${res.status} ${await res.text().catch(() => "")}`);
    return "";
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}
