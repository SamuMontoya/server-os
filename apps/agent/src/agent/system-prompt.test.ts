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
import { buildSystemPrompt, withTimeout } from "./system-prompt.js";

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

/**
 * `withTimeout` (Épica C, C2 — buzón #12 "tareas tardan 3-4x más que Claude
 * directo"). `buildTurnContext` esperaba SIN límite a `recentMemories` +
 * `searchKnowledge` antes del primer token del turno; el propio comentario de
 * `buildSystemPrompt` documentaba que cada ida a Supabase son ~1,3s (hasta 6
 * la semántica) — una sola ida lenta se comía eso entero. Estos tests cubren
 * el helper que ahora acota esa espera.
 */
test("withTimeout: si la promesa resuelve antes del límite, devuelve su valor real", async () => {
  const out = await withTimeout(Promise.resolve("real"), "fallback", "test-rapido", 50);
  assert.equal(out, "real");
});

test("withTimeout: si la promesa tarda más que el límite, cae al fallback sin esperarla", async () => {
  const lenta = new Promise<string>((resolve) => setTimeout(() => resolve("tarde"), 500));
  const antes = Date.now();
  const out = await withTimeout(lenta, "fallback", "test-lento", 50);
  const transcurrido = Date.now() - antes;
  assert.equal(out, "fallback");
  assert.ok(transcurrido < 500, `debía resolver cerca de 50ms, tardó ${transcurrido}ms`);
});

test("withTimeout: adversarial — la promesa original rechaza (red caída) y NO truena: cae al fallback", async () => {
  const rechaza = Promise.reject(new Error("network error (prueba)"));
  const out = await withTimeout(rechaza, "fallback", "test-rechazo", 1_000);
  assert.equal(out, "fallback");
});

test("withTimeout: adversarial — límite en 0ms sigue sin tronar (caso borde)", async () => {
  const out = await withTimeout(new Promise<string>(() => {}), "fallback-cero", "test-cero", 0);
  assert.equal(out, "fallback-cero");
});
