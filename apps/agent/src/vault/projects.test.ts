/**
 * Épica F, F1 (contexto de materia persistente — MVP 4 del backlog). Antes
 * de este fix, el sílabus/orden de unidades y el perfil de estudiantes de
 * una materia (Producción, Escuela Dominical…) vivían solo en prosa suelta
 * dentro de "Estado Actual" (o en la cabeza de Jaime) — nada los extraía de
 * forma estructurada, así que `buildSystemPrompt` nunca los veía y Jaime
 * tenía que repetirlos a mano en cada chat nuevo, o confiar en que el
 * modelo "se acordara" de una conversación anterior.
 *
 * `extractSection`/`extractTasks` ya existían (probados indirectamente vía
 * `readProjects`, nunca con un test propio) — este archivo los cubre
 * directo, más las dos secciones NUEVAS (`## Sílabus`, `## Perfil de
 * Estudiantes`) con el mismo extractor.
 *
 * `readProjects()` en sí depende de `env.VAULT_PATH` (congelado al cargar
 * `env.ts` desde `process.env`, no inyectable) — en vez de pelear con eso,
 * la integración real contra el vault de PRODUCCIÓN (con las notas de
 * Producción/Escuela Dominical ya migradas a este formato) vive en
 * `system-prompt.test.ts`, que ya tiene el patrón de "se salta sin
 * credenciales/vault real" establecido para C2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractSection, extractTasks } from "./projects.js";

test("extractSection: extrae el contenido entre un header y el siguiente header de nivel 1-3", () => {
  const md = `# Título\n\n## Sílabus\nLínea 1\nLínea 2\n\n## Otra sección\nNo debe aparecer`;
  const out = extractSection(md, /^#{1,3}\s*.*S[ií]labus/i);
  assert.equal(out, "Línea 1\nLínea 2");
});

test("extractSection: header con emoji sigue matcheando (tolerante)", () => {
  const md = `## 📚 Sílabus\nContenido con emoji en el header`;
  const out = extractSection(md, /^#{1,3}\s*.*S[ií]labus/i);
  assert.equal(out, "Contenido con emoji en el header");
});

test("extractSection: sección ausente devuelve string vacío, no revienta", () => {
  const md = `# Título\n\n## Estado Actual\nalgo`;
  const out = extractSection(md, /^#{1,3}\s*.*S[ií]labus/i);
  assert.equal(out, "");
});

test("extractSection: sección es la ÚLTIMA del documento (sin header siguiente) toma hasta el final", () => {
  const md = `# Título\n\n## Perfil de Estudiantes\nEdad 11-18, grupo mixto, 5-13 estudiantes.`;
  const out = extractSection(md, /^#{1,3}\s*.*Perfil de Estudiantes/i);
  assert.equal(out, "Edad 11-18, grupo mixto, 5-13 estudiantes.");
});

test("extractSection: adversarial — un subtítulo ### DENTRO de la sección la corta ahí (limitación conocida, no usar headers anidados en Sílabus/Perfil)", () => {
  // Documenta el comportamiento real, no lo oculta: si alguien escribe un
  // "### Ciclo 1" dentro de "## Sílabus", la sección se corta ahí. Por eso
  // las notas de materia usan listas (bullets), no sub-headers, dentro de
  // estas dos secciones — ver produccion.md / escuela-dominical-juvenil.md.
  const md = `## Sílabus\n### Ciclo 1\nEsto se pierde`;
  const out = extractSection(md, /^#{1,3}\s*.*S[ií]labus/i);
  assert.equal(out, "");
});

test("extractTasks: toma líneas de checklist y bullets simples, tope de 12", () => {
  const section = Array.from({ length: 15 }, (_, i) => `- [ ] tarea ${i}`).join("\n");
  const out = extractTasks(section);
  assert.equal(out.length, 12);
  assert.equal(out[0], "tarea 0");
});

test("extractTasks: línea vacía o sin viñeta se descarta sin tronar", () => {
  const section = "- [ ] tarea real\n\nuna línea suelta sin viñeta\n- bullet simple";
  const out = extractTasks(section);
  assert.deepEqual(out, ["tarea real", "bullet simple"]);
});
