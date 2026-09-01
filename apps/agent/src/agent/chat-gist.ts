/**
 * Resumen de UNA frase de una respuesta larga, para la pantalla chica del
 * reloj cuando está siguiendo un chat del Laboratorio (ver watch/active-link.ts
 * y GET/POST /watch/link en index.ts).
 *
 * Mismo motivo que chat-title.ts: la pantalla no tiene espacio para el
 * markdown completo, y una respuesta de un turno agéntico puede traer pasos,
 * código, tablas — nada de eso cabe ni sirve en 40mm. Se le pide al modelo
 * MÁS barato (haiku) que la aplane a lo que realmente importa saber sin sacar
 * el teléfono.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { optionsFor } from "./models.js";

const SYSTEM = `Resumes la respuesta de un asistente para la pantalla de un reloj (40mm).

Reglas estrictas:
- UNA sola frase corta. Sin punto final si es tan corta que no hace falta.
- En español, salvo términos técnicos que ya vienen en inglés.
- Sin markdown: nada de asteriscos, almohadillas, guiones, backticks, enlaces.
- Si la respuesta es un dato concreto (un número, un nombre, un sí/no), di SOLO eso.
- Si la respuesta lista varias cosas, di cuántas y la más importante, no la lista entera.
- Sin preámbulo ("La respuesta es...", "En resumen..."): ve directo al contenido.
- Responde SOLO con la frase. Ninguna otra palabra.`;

/** Limpia lo que el modelo pueda colar de más (comillas, markdown residual). */
export function cleanGist(raw: string): string {
  const flat = raw
    .replace(/["“”'`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  // Una "frase" que en realidad es un párrafo entero es peor que nada: el
  // cliente cae a mostrar el texto completo (recortado) en vez de esto.
  return flat.length > 180 ? "" : flat;
}

/**
 * Devuelve la frase, o "" si el modelo falla o se va de tema. Nunca lanza:
 * quien llama decide entre esto y su propio recorte del texto.
 */
export async function gistForAnswer(text: string): Promise<string> {
  const msg = text.trim().slice(0, 4000);
  if (!msg) return "";
  let out = "";
  try {
    const q = query({
      prompt: `Respuesta a resumir:\n"""\n${msg}\n"""\n\nFrase para el reloj:`,
      options: {
        systemPrompt: SYSTEM,
        ...optionsFor("chatGist"),
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        permissionMode: "default",
      },
    });
    for await (const message of q) {
      const m = message as Record<string, any>;
      if (m.type !== "assistant") continue;
      for (const block of m.message?.content ?? m.content ?? []) {
        if (block.type === "text" && block.text) out += block.text as string;
      }
    }
  } catch (err) {
    console.error("[chat-gist]", String(err).slice(0, 200));
    return "";
  }
  return cleanGist(out);
}
