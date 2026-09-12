/**
 * Acuse instantáneo: una frase CORTÍSIMA de intención ("Reviso el repo",
 * "Dale, lo arreglo"), generada por la vía directa (mismo mecanismo que
 * fast-turn.ts/direct-complete.ts) EN PARALELO al arranque del motor
 * completo — nunca antes, nunca bloqueando el turno real.
 *
 * Por qué existe: cualquier turno que necesita el CLI/Agent SDK (nivel
 * bajo/medio/alto, o un trivial que terminó escalando) paga ~4-5s fijos de
 * arranque de proceso antes de la primera palabra — límite arquitectural ya
 * señalado (ver memoria del proyecto), no algo que este archivo resuelva.
 * Mientras tanto el usuario mira el orbe vacío. Esto no acorta esos 4-5s:
 * les pone algo visible ENCIMA, generado aparte y mucho más rápido (haiku,
 * sin tools, ~1 frase).
 *
 * ESPERADO, no fire-and-forget — probado en vivo: disparar esto sin esperar
 * (en paralelo al `query()` del SDK) lo dejaba tardar los mismos ~4s que el
 * motor pesado, no los ~0.8s que mide en aislamiento. Causa: arrancar el
 * proceso `claude` ocupa el hilo único de Node lo suficiente como para que la
 * respuesta de ESTA llamada (que ya viajó y volvió por red) no se procese
 * hasta que ese hilo se libera — "en paralelo" en el código no es paralelo de
 * verdad si el resto del turno bloquea el loop. Por eso quien llama debe
 * ESPERAR esto (acotado por `conTecho`) ANTES de arrancar el motor pesado.
 */
import { completarDirecto } from "./direct-complete.js";

const SISTEMA = `Te acaban de escribir un mensaje. Respondé ÚNICAMENTE con una frase CORTÍSIMA (menos de 8 palabras), en español informal, diciendo qué vas a hacer AHORA MISMO — la intención, no la respuesta en sí ("Reviso el repo", "Dale, lo arreglo", "Busco en la memoria", "Dejame ver eso"). Sin comillas, sin punto final si es muy corta, sin explicar nada más. Si el mensaje no implica ninguna acción previa (un saludo, algo trivial de responder directo), respondé con una cadena vacía.`;

const TECHO_MS = 1500;

async function conTecho(promesa: Promise<string>): Promise<string> {
  const techo = new Promise<string>((resolve) => setTimeout(() => resolve(""), TECHO_MS));
  return Promise.race([promesa, techo]);
}

export async function acuseInstantaneo(mensaje: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "";
  const texto = await conTecho(
    completarDirecto(SISTEMA, mensaje.slice(0, 800), { maxTokens: 20, signal }),
  );
  const limpio = texto
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  // Sin frase, o el modelo se fue por las ramas (una frase entera en vez de
  // la intención corta): mejor nada que un acuse largo o roto.
  if (!limpio || limpio.length > 60) return "";
  return limpio;
}
