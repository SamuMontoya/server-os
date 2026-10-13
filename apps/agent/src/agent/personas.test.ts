import test from "node:test";
import assert from "node:assert/strict";
import { personaPreamble } from "./personas.js";

/**
 * Épica H (MVP 6): Personas/"sombreritos" — sin Supabase configurado en
 * test (ver src/supabase.ts: exporta `null` si faltan env vars), getPersonas()
 * degrada a [] y personaPreamble() siempre devuelve "" — el comportamiento
 * real con datos vive en epic-h-personas.spec.ts (E2E contra el backend real).
 */

test("personaPreamble: null/undefined/vacío no truena, devuelve ''", async () => {
  assert.equal(await personaPreamble(null), "");
  assert.equal(await personaPreamble(undefined), "");
  assert.equal(await personaPreamble(""), "");
});

test("personaPreamble: adversarial — persona inventada/inyección no truena", async () => {
  assert.equal(await personaPreamble("persona-que-no-existe"), "");
  assert.equal(await personaPreamble("<script>alert(1)</script>"), "");
});
