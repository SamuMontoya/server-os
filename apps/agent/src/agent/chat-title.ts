/**
 * Título corto de un chat, generado por el modelo MÁS BARATO (haiku).
 *
 * Samu pidió que la lista de chats del Laboratorio no muestre las primeras 48
 * letras del mensaje (que casi siempre se corta a mitad de palabra y se lee
 * como ruido) sino un NOMBRE: dos o tres palabras que digan de qué va el chat.
 *
 * Por qué un pase de modelo y no una heurística: recortar texto no entiende de
 * qué habla el mensaje. "necesito que revises el tema de la persistencia en el
 * chat y de que no se caigan los comandos" recortado da "necesito que revises
 * el tema de la persist…"; el modelo da "Persistencia del chat".
 *
 * Por qué haiku y sin tools: es una frase de entrada y tres palabras de salida.
 * No hay nada que razonar ni que buscar.
 *
 * Por qué API directa y no el Agent SDK: `query()` arranca un proceso `claude`
 * completo por llamada — medido en vivo, 8.2s para esto, compitiendo por CPU
 * con el turno real. Mismo bypass que ya usa el reloj (ver direct-complete.ts).
 */
import { completarDirecto } from "./direct-complete.js";

const SYSTEM = `Nombras conversaciones. Recibes el PRIMER mensaje de un chat y devuelves un título.

Reglas estrictas:
- MÁXIMO 3 palabras. Dos es mejor que tres.
- En español, salvo que el término técnico sea en inglés (por ejemplo "Deploy de Vercel").
- Sin emojis, sin comillas, sin punto final, sin prefijos tipo "Título:".
- Describe el TEMA, no la acción de pedir. "Arreglar el login" → "Login roto", no "Petición de arreglo".
- Primera letra en mayúscula, el resto normal (no Title Case, no MAYÚSCULAS).
- Responde SOLO con el título. Ninguna otra palabra.`;

/** Recorta a 3 palabras y limpia lo que el modelo pueda colar de más. */
export function cleanTitle(raw: string): string {
  const flat = raw
    .replace(/["“”'`*_#]/g, "")
    .replace(/^\s*t[íi]tulo\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!flat) return "";
  const words = flat.split(" ").slice(0, 3);
  const out = words.join(" ");
  // Un modelo que se va por las ramas (una frase entera) es peor que no tener
  // título: mejor que el cliente caiga a su heurística de siempre.
  return out.length > 40 ? "" : out;
}

/**
 * Devuelve el título, o "" si el modelo falla o responde cualquier cosa. Nunca
 * lanza: quien llama solo tiene que decidir entre esto y su fallback.
 */
export async function titleForChat(firstMessage: string): Promise<string> {
  const msg = firstMessage.trim().slice(0, 1500);
  if (!msg) return "";
  const text = await completarDirecto(
    SYSTEM,
    `Primer mensaje del chat:\n"""\n${msg}\n"""\n\nTítulo (máx. 3 palabras):`,
    { maxTokens: 20 },
  );
  return cleanTitle(text);
}
