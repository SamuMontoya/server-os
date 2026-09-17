/**
 * Test del system prompt estático (reglas). Corre con `node:test` sobre tsx.
 *
 * Bug real (2026-09-17): Jaime pidió DOS VECES ("recuerda que en lo posible
 * no muestres tablas en ASCII, muéstralas en formato markdown", 14 y 17 sept)
 * que el agente dejara de usar ASCII art para tablas. El agente respondió
 * "entendido"/"anotado" ambas veces pero nunca llamó `save_preference` — a lo
 * sumo guardó una `save_memory` con scope de proyecto (`transmedia`), que solo
 * se recupera por búsqueda semántica del mensaje del turno y no aparece
 * garantizado en cada conversación futura. Resultado: el 17 de septiembre
 * volvió a entregar tablas en ASCII (`┌─┐`) pese a la corrección previa.
 *
 * Fix de raíz: (1) reglas explícitas y duras en el system prompt — nunca
 * ASCII, y "recuerda que..." dispara save_preference/save_memory EN EL
 * MISMO TURNO, no solo prosa — y (2) la preferencia real ya se guardó vía
 * save_preference (persiste sola, este test solo cubre que el texto de las
 * reglas no se pierda en un refactor futuro).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./system-prompt.js";

// `magro = true` salta la precarga de proyectos/preferencias (Supabase) y
// projects (vault) — deja solo el bloque estático de identidad/reglas, que
// es justo lo que este test necesita, sin depender de credenciales de red.
test("las reglas incluyen prohibición explícita de ASCII para tablas/diagramas", async () => {
  const prompt = await buildSystemPrompt(undefined, true);
  assert.match(prompt, /NUNCA diagramas ASCII/);
  assert.match(prompt, /markdown est[aá]ndar/i);
});

test("las reglas instruyen persistir de inmediato un pedido de 'recuerda que'", async () => {
  const prompt = await buildSystemPrompt(undefined, true);
  assert.match(prompt, /recuerda que\.\.\./);
  assert.match(prompt, /save_preference/);
  assert.match(prompt, /EN ESE MISMO TURNO/);
});

test("distingue save_preference (global, garantizado) de save_memory (scoped, por búsqueda)", async () => {
  const prompt = await buildSystemPrompt(undefined, true);
  assert.match(prompt, /solo `# Preferencias de/);
});
