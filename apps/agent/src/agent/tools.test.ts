import test from "node:test";
import assert from "node:assert/strict";
import { slugifySkillId } from "./tools.js";
import { isValidSkillId } from "./skills.js";

/**
 * Épica G, G1 (motor genérico de creación/edición de skills por conversación)
 * — unitarios de `slugifySkillId`, la pieza pura de `manage_skill` (la tool
 * en sí envuelve una escritura a Supabase vía el SDK `tool()`, que no se
 * puede invocar directo sin el runtime del agente — ver skills.test.ts para
 * la cobertura de `skillPreamble`, que sí recorre el lookup de custom
 * skills, y epic-g-skills.spec.ts para el E2E end-to-end).
 */

test("slugifySkillId: caso de prueba pedido por Jaime — 'Resumen de YouTube'", () => {
  assert.equal(slugifySkillId("Resumen de YouTube"), "resumen-de-youtube");
});

test("slugifySkillId: quita tildes y caracteres especiales", () => {
  assert.equal(slugifySkillId("Asesoría Jurídica & Legal"), "asesoria-juridica-legal");
});

test("slugifySkillId: adversarial — espacios múltiples, mayúsculas, símbolos no truena", () => {
  assert.equal(slugifySkillId("   Hola    Mundo!!!   "), "hola-mundo");
  assert.equal(slugifySkillId("💀🔥 emoji puro 🔥💀"), "emoji-puro");
});

test("slugifySkillId: adversarial — input vacío/solo símbolos produce string vacío (manage_skill lo rechaza)", () => {
  assert.equal(slugifySkillId(""), "");
  assert.equal(slugifySkillId("!!!???"), "");
});

test("slugifySkillId: un label que colisiona con un skill fijo se detecta vía isValidSkillId", () => {
  const id = slugifySkillId("Biblical Counselor");
  assert.equal(id, "biblical-counselor");
  assert.equal(isValidSkillId(id), true); // manage_skill debe rechazar este id
});
