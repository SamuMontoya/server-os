import test from "node:test";
import assert from "node:assert/strict";
import { esDesbordeDeContexto } from "./compact.js";

/**
 * El desborde de contexto se reconoce por texto: la API lo entrega como un
 * mensaje de asistente sintético y el CLI lo repite en el `result` y en la
 * excepción del iterador. Si deja de reconocerse, vuelve a caer en `api_error`
 * y se reintenta a ciegas tres veces lo mismo (caso real del chat "Backlog
 * prioritario", 2026-10-14).
 */
test("reconoce las formas en que llega el aviso de desborde de contexto", () => {
  for (const t of [
    "Prompt is too long",
    "prompt is too long: 215504 tokens > 200000 maximum",
    "Error: Claude Code returned an error result: Prompt is too long",
    "Conversation too long. Press esc twice to go up a few messages and try again.",
  ]) {
    assert.equal(esDesbordeDeContexto(t), true, t);
  }
});

test("no confunde otros fallos de la API (transitorios) con un desborde", () => {
  for (const t of [
    "",
    undefined,
    null,
    "API Error: 429 Rate limit reached",
    "529 overloaded_error",
    "Claude AI usage limit reached",
    "The prompt was fine, the server was too slow",
    "Error: Claude Code returned an error result: Reached maximum number of turns (6)",
  ]) {
    assert.equal(esDesbordeDeContexto(t as string | undefined | null), false, String(t));
  }
});
