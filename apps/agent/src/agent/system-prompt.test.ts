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
import { buildSystemPrompt, buildTurnContext, withTimeout } from "./system-prompt.js";
import { env } from "../env.js";

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

/**
 * Bug real encontrado en esta auditoría (2026-10-12): el commit `0fe9dc2`
 * reescribió esta prosa ("Llama la tool EN ESE MISMO TURNO...") pero nunca
 * actualizó este assert, que seguía buscando la frase VIEJA ("solo `#
 * Preferencias de ${OWNER}` se inyecta garantizado...") — eliminada en ese
 * mismo commit. El test quedó en rojo en silencio desde entonces (nadie lo
 * corrió como parte de un protocolo completo hasta ahora). Reescrito contra
 * el texto real actual, mismo INTENTO: confirmar que el prompt distingue
 * save_preference (garantizado, cada turno) de save_memory con `project`
 * (scoped, depende de que la búsqueda semántica lo encuentre).
 */
test("distingue save_preference (global, garantizado cada turno) de save_memory con project (scoped)", async () => {
  const prompt = await buildSystemPrompt(undefined, true);
  assert.match(prompt, /save_preference:.*Se inyecta completo en CADA turno/s);
  assert.match(prompt, /save_memory con `project`:.*SOLO a un proyecto puntual/s);
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

/**
 * Integración real de C2: `buildTurnContext` es quien de verdad CABLEA
 * `withTimeout` a `recentMemories`/`searchKnowledge` (ambas contra Supabase
 * real — este repo no tiene infraestructura de mocking de módulos, ver el
 * resto de la suite). Los tests de arriba solo cubren el helper aislado con
 * promesas de mentira; sin esto, un refactor futuro podría romper el cableado
 * real (p. ej. dejar de pasarle el límite, o volver a un `Promise.all` sin
 * `withTimeout`) y ningún test lo notaría. Requiere credenciales de Supabase
 * en el entorno (las mismas que usa el agente en producción) — si faltan, se
 * salta sola en vez de fallar en rojo por un problema de entorno de CI.
 */
const tieneSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

test(
  "buildTurnContext: con mensaje real, resuelve y nunca tarda más que el margen del tope (recentMemories + searchKnowledge en paralelo, cada una acotada)",
  { skip: !tieneSupabase && "sin credenciales de Supabase en el entorno" },
  async () => {
    const antes = Date.now();
    const out = await buildTurnContext("prueba de integración C2", { recent: 2, relevant: 2, chars: 100 });
    const transcurrido = Date.now() - antes;
    assert.equal(typeof out, "string");
    // Las dos llamadas corren en PARALELO (Promise.all), cada una acotada a
    // CONTEXT_FETCH_TIMEOUT_MS (2.5s) — el total nunca debería acercarse al
    // doble de eso (lo que pasaría si en algún refactor volvieran a correr
    // en serie). Margen generoso (6s) para no ser frágil en una red lenta.
    assert.ok(transcurrido < 6_000, `tardó ${transcurrido}ms — ¿dejaron de correr en paralelo o de tener tope?`);
  },
);

test(
  "buildTurnContext: magro=true salta TODA la precarga (ni siquiera intenta recentMemories/searchKnowledge)",
  async () => {
    const antes = Date.now();
    const out = await buildTurnContext("cualquier cosa", undefined, true);
    const transcurrido = Date.now() - antes;
    assert.equal(out, "");
    // Sin red de por medio, esto es prácticamente instantáneo — si tardara
    // cerca del tope de `withTimeout`, significaría que `magro` dejó de
    // cortar antes de llegar a la red.
    assert.ok(transcurrido < 200, `magro=true tardó ${transcurrido}ms — ¿dejó de saltarse la precarga?`);
  },
);

test("buildTurnContext: adversarial — mensaje vacío/solo espacios devuelve '' sin tocar red", async () => {
  const antes = Date.now();
  const out = await buildTurnContext("   ", { recent: 2, relevant: 2, chars: 100 });
  const transcurrido = Date.now() - antes;
  assert.equal(out, "");
  assert.ok(transcurrido < 200, `mensaje vacío tardó ${transcurrido}ms — ¿dejó de cortar antes de la red?`);
});

/**
 * Épica F, F1 (contexto de materia persistente — MVP 4 del backlog). Las
 * notas de `produccion` y `escuela-dominical-juvenil` ya tienen secciones
 * `## Sílabus`/`## Perfil de Estudiantes` reales en el vault (migradas en
 * esta misma pasada) — estos tests verifican contra el VAULT REAL, no un
 * fixture de mentira, que `buildSystemPrompt` de verdad las inyecta cuando
 * ese proyecto está en foco, y que un proyecto sin esas secciones (jaime-os,
 * `tipo: producto`) no arrastra encabezados vacíos.
 */
const tieneVault = Boolean(env.VAULT_PATH);

test(
  "buildSystemPrompt: con foco en una materia real (produccion), inyecta Sílabus y Perfil de Estudiantes",
  { skip: !tieneVault && "sin VAULT_PATH en el entorno" },
  async () => {
    const prompt = await buildSystemPrompt("produccion", false);
    assert.match(prompt, /Sílabus\/estructura oficial/);
    assert.match(prompt, /Perfil de estudiantes\/audiencia/);
    // Contenido real de la nota, no solo el encabezado — confirma que de
    // verdad lee la sección y no un placeholder.
    assert.match(prompt, /Unidad 5|U5 — Evaluación/);
    assert.match(prompt, /nivel socioeconómico medio-bajo/i);
  },
);

test(
  "buildSystemPrompt: con foco en otra materia real (escuela-dominical-juvenil), inyecta SU PROPIO sílabus/perfil (no el de produccion)",
  { skip: !tieneVault && "sin VAULT_PATH en el entorno" },
  async () => {
    const prompt = await buildSystemPrompt("escuela-dominical-juvenil", false);
    assert.match(prompt, /Hijos del Pacto/);
    assert.match(prompt, /11 a 18 años/);
    // Negativo acotado al bloque de FOCO (no al prompt completo): la sección
    // global "# Preferencias de Jaime" SÍ puede mencionar "nivel
    // socioeconómico medio-bajo" (viene de `planeacion_clases_estandar`,
    // preferencia transversal que se inyecta SIEMPRE, sin importar el
    // proyecto) — eso no es una fuga de F1. Lo que SÍ sería una fuga real es
    // que el BLOQUE DE FOCO de esta materia traiga el perfil de la OTRA.
    const focoBlock = prompt.slice(
      prompt.indexOf("FOCO DE CONVERSACIÓN"),
      prompt.indexOf("---", prompt.indexOf("FOCO DE CONVERSACIÓN")),
    );
    assert.doesNotMatch(focoBlock, /nivel socioeconómico medio-bajo/i);
  },
);

test(
  "buildSystemPrompt: proyecto sin Sílabus/Perfil (jaime-os, tipo producto) no agrega encabezados vacíos",
  { skip: !tieneVault && "sin VAULT_PATH en el entorno" },
  async () => {
    const prompt = await buildSystemPrompt("jaime-os", false);
    assert.doesNotMatch(prompt, /Sílabus\/estructura oficial/);
    assert.doesNotMatch(prompt, /Perfil de estudiantes\/audiencia/);
  },
);

test("buildSystemPrompt: adversarial — slug de proyecto inexistente no rompe nada, sigue sin bloque de FOCO", async () => {
  const prompt = await buildSystemPrompt("este-proyecto-no-existe-jamas", false);
  assert.doesNotMatch(prompt, /FOCO DE CONVERSACIÓN/);
  assert.ok(prompt.length > 0);
});

/**
 * Épica F, F2 (plan de clase con profundidad correcta desde el primer
 * intento). El checklist de profundidad vive JUNTO al sílabus/perfil en el
 * bloque de FOCO (no solo como preferencia global lejana) — se activa
 * únicamente cuando hay sílabus, porque eso es lo que distingue "estoy
 * planeando una clase" de cualquier otra conversación sobre el proyecto.
 */
test(
  "buildSystemPrompt: materia con sílabus (produccion) trae el checklist de profundidad del primer intento",
  { skip: !tieneVault && "sin VAULT_PATH en el entorno" },
  async () => {
    const prompt = await buildSystemPrompt("produccion", false);
    assert.match(prompt, /CUMPLE DE UNA, sin esperar una ronda de corrección/);
    assert.match(prompt, /notas_profesor_por_diapositiva/);
    assert.match(prompt, /PÍDELO antes de generar/);
  },
);

test(
  "buildSystemPrompt: proyecto sin sílabus (jaime-os, tipo producto) NO trae el checklist de plan de clase",
  { skip: !tieneVault && "sin VAULT_PATH en el entorno" },
  async () => {
    const prompt = await buildSystemPrompt("jaime-os", false);
    assert.doesNotMatch(prompt, /CUMPLE DE UNA, sin esperar una ronda de corrección/);
  },
);

test("buildSystemPrompt: adversarial — magro=true salta el checklist igual que el resto de la precarga (no debe tocar red/vault)", async () => {
  const antes = Date.now();
  const prompt = await buildSystemPrompt("produccion", true);
  const transcurrido = Date.now() - antes;
  assert.doesNotMatch(prompt, /CUMPLE DE UNA, sin esperar una ronda de corrección/);
  assert.ok(transcurrido < 500, `magro tardó ${transcurrido}ms — ¿dejó de saltar la precarga?`);
});

test(
  "buildSystemPrompt: F3 — materia con sílabus trae checklist de diapositivas + identidad Drive",
  { skip: !tieneVault && "sin VAULT_PATH en el entorno" },
  async () => {
    const prompt = await buildSystemPrompt("produccion", false);
    assert.match(prompt, /identidad visual del Drive de Presentaciones/);
    assert.match(prompt, /NOTAS DEL PROFESOR \(inmediatamente después, no al final\)/);
    assert.match(prompt, /máximo 5-7 líneas de texto por slide/);
  },
);
