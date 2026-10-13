import test from "node:test";
import assert from "node:assert/strict";
import { skillPreamble, isValidSkillId } from "./skills.js";

test("skillPreamble: skill válido devuelve preámbulo con el contenido del GEM", async () => {
  const out = await skillPreamble("asesor-escuela-dominical");
  assert.match(out, /SKILL ACTIVO/);
  assert.match(out, /Teología Reformada clásica/);
});

test("skillPreamble: los 8 skills documentados generan preámbulo no vacío", async () => {
  const ids = [
    "asesor-presencial",
    "asesor-virtual",
    "generador-rubricas",
    "asesor-diseno-grafico",
    "asesor-escuela-dominical",
    "investigador-academico",
    "biblical-counselor",
    "theologian-apologist",
  ];
  for (const id of ids) {
    const out = await skillPreamble(id);
    assert.ok(out.length > 50, `skill ${id} debería tener preámbulo sustancioso`);
  }
});

test("skillPreamble: adversarial — null/undefined/string vacío/basura no truena, devuelve ''", async () => {
  // "skill-que-no-existe" y el intento de inyección caen al lookup de
  // custom_skills (Épica G, G1) — sin Supabase configurado en test,
  // getCustomSkills() degrada a [] y el resultado sigue siendo "".
  assert.equal(await skillPreamble(null), "");
  assert.equal(await skillPreamble(undefined), "");
  assert.equal(await skillPreamble(""), "");
  assert.equal(await skillPreamble("skill-que-no-existe"), "");
  assert.equal(await skillPreamble("<script>alert(1)</script>"), "");
});

test("isValidSkillId: valida correctamente ids reales vs inventados", () => {
  assert.equal(isValidSkillId("biblical-counselor"), true);
  assert.equal(isValidSkillId("pastor-falso"), false);
  assert.equal(isValidSkillId(123), false);
  assert.equal(isValidSkillId(null), false);
});
