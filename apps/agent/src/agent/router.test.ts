import { test } from "node:test";
import assert from "node:assert/strict";

import { capEffort, capTier, classify, raiseTier, routeTurn } from "./router.js";

/**
 * Tests del router de costo.
 *
 * Por qué existen: el router decide con qué esfuerzo (y modelo, en el caso
 * trivial) abre cada conversación, y equivocarse por arriba se paga en la
 * ventana de 5h — es el componente donde un falso positivo cuesta plata de
 * verdad. Estaba sin tests y una regresión silenciosa (un verbo de más en la
 * lista) no la habría cachado nadie hasta ver la factura.
 *
 * Los mensajes de abajo NO son inventados: son mensajes REALES del dueño,
 * copiados de conversaciones, y cada bloque documenta el falso positivo
 * concreto que se está evitando.
 */

test("los saludos y las continuaciones caen en trivial (haiku)", () => {
  for (const m of ["hola", "gracias", "listo", "ok", "dale", "Sigue", "continúa", "TLDR"]) {
    assert.equal(classify(m).tier, "trivial", `"${m}" debería ser trivial`);
  }
});

test("una pregunta de estado corta se responde con haiku (trivial)", () => {
  for (const m of [
    "Que sub carpetas tienes? TLDR",
    "Ya está todo arriba? TLDR",
    "¿qué tengo pendiente hoy?",
    "cómo va el proyecto?",
    "Con el 1 no serviría?",
  ]) {
    assert.equal(classify(m).tier, "trivial", `"${m}" debería ser trivial`);
  }
});

test("el nivel trivial SÍ se alcanza (antes no se disparaba nunca)", () => {
  // La regresión histórica: el nivel barato existía en la tabla y en la
  // práctica clasificaba 0 de 37 mensajes reales, porque las comprobaciones de
  // trabajo iban primero y cualquier verbo de la lista larga lo adelantaba.
  const reales = ["TLDR", "Sigue", "Que ponemos?", "Ya está todo arriba? TLDR"];
  const trivial = reales.filter((m) => classify(m).tier === "trivial");
  assert.equal(trivial.length, reales.length, "el nivel trivial volvió a quedar muerto");
});

test("pedir que se ARREGLE código sí llega a esfuerzo alto", () => {
  for (const m of [
    "Arregla los puntos relacionados con el consumo y la página de laboratorio",
    "Continúa, soluciona los agujeros",
    "refactoriza este módulo",
    "implementa el endpoint de métricas",
    "corrige el bug del scroll",
    "optimiza la query que tarda 4s",
  ]) {
    assert.equal(classify(m).tier, "alto", `"${m}" debería ser alto`);
  }
});

test("un archivo o una ruta de FUENTE llega a esfuerzo alto", () => {
  for (const m of [
    "revisa apps/web/src/app/laboratorio/page.tsx",
    "qué hace router.ts",
    "mira este bloque ```const x = 1```",
    "explícame apps/agent/src/agent",
  ]) {
    assert.equal(classify(m).tier, "alto", `"${m}" debería ser alto`);
  }
});

test("auditorías, investigación y análisis van a esfuerzo alto (sobre sonnet, nunca opus)", () => {
  // El encargo explícito del dueño: nada de opus — pero lo que de verdad
  // implica "pensar y razonar" (auditar, investigar, analizar) sí merece
  // esfuerzo alto, solo que sobre sonnet en vez de un modelo aparte.
  for (const m of [
    "Analiza el repo de server-os y dime dónde se está yendo el consumo",
    "auditate a ti mismo brevemente y si todo bien commit y push",
    "Investiga en las carpetas como se llama la api de voz gratuita",
    "compara las dos alternativas de VPS",
    "planifica la semana",
    "resuelve cuál conviene",
  ]) {
    assert.equal(classify(m).tier, "alto", `"${m}" debería ser alto: ${m}`);
  }
});

test("un pedido corto sin más señal es trivial (haiku): no es código ni orquestación", () => {
  for (const m of ["cámbialo a azul", "pon el título más grande", "hazlo más corto por favor"]) {
    assert.equal(classify(m).tier, "trivial", `"${m}" debería ser trivial`);
  }
});

test("el caso general (búsquedas, redacción, pedidos largos) es trivial: haiku responde corto", () => {
  // Pedido explícito del dueño: charla y redacción sin señal de código u
  // orquestación va a haiku por defecto, no a sonnet — antes esto caía en
  // 'medio' por ser largo; ahora la longitud sola ya no sube el esfuerzo.
  const largo =
    "Necesito que me ayudes a pensar en cómo estructurar la propuesta para el cliente, " +
    "incluyendo qué secciones debería tener y en qué orden presentarlas para que quede clara.";
  assert.equal(classify(largo).tier, "trivial");
});

test("orquestar (commit, push, deploy, pnpm) se queda en sonnet, no baja a haiku", () => {
  // El pedido explícito: 'el código y la orquestación lo hace con sonnet'.
  // Antes esto caía en el mismo 'caso general' que la charla (esfuerzo
  // medio); con haiku como default para charla hacía falta una señal propia
  // para que orquestar NO se fuera a trivial junto con todo lo demás.
  for (const m of [
    "commit y push en samuel",
    "corre pnpm test",
    "haz el deploy",
    "reinicia el servicio",
    "instala las dependencias",
  ]) {
    assert.equal(classify(m).tier, "bajo", `"${m}" debería quedarse en sonnet (bajo)`);
  }
});

test("el markdown del vault NO es señal de código", () => {
  // `.md` es el formato NATIVO del producto (todo el vault de Obsidian). Con
  // `md` en los marcadores de código, hablar de una nota abría el hilo en el
  // nivel más caro — y como el nivel queda FIJO por sesión, UNA mención dejaba
  // la conversación entera ahí.
  for (const m of [
    "qué dice mi nota de finanzas.md",
    "resume mi nota de perfil.md",
    "recuérdame la reunión de mañana.md",
  ]) {
    assert.notEqual(classify(m).tier, "alto", `"${m}" no debería ser alto`);
  }
});

test("una ruta que no es de código tampoco lo es", () => {
  // Con el patrón de dos segmentos, "/descargas/reunion" clasificaba como
  // código. Ahora la ruta pide tres segmentos.
  assert.notEqual(classify("mira el video que subí a /descargas/reunion").tier, "alto");
});

test("preguntar POR una migración no es hacerla", () => {
  const m =
    "Ok, no problem. Ahora quiero que sigamos con el desarrollo que estamos haciendo " +
    "en Kreanding para la oferta 1. En que quedamos ayer y que sigue? Creo que solo " +
    "hicimos la migración, no? TLDR";
  assert.notEqual(classify(m).tier, "alto", "'hicimos la migración' es una consulta");
});

test("correr comandos es orquestación, no autoría", () => {
  // commit/push/pnpm son exactamente el caso que el dueño pidió mover a sonnet
  // (y ahora, con esfuerzo, a algo por debajo de 'alto').
  for (const m of ["commit y push en samuel", "corre pnpm test", "haz el deploy"]) {
    assert.notEqual(classify(m).tier, "alto", `"${m}" no debería ser alto`);
  }
});

test("el nivel queda FIJO por sesión (protege el caché de prompt)", () => {
  const s = "sesion-fija-1";
  const primero = routeTurn("Arregla el bug del login", s);
  assert.equal(primero.tier, "alto");
  assert.equal(primero.pinned, false);
  // Un "gracias" a mitad del hilo no debe bajar el nivel: cambiar de esfuerzo
  // tira el prefijo cacheado y re-cachear cuesta más que lo ahorrado.
  const segundo = routeTurn("gracias", s);
  assert.equal(segundo.tier, "alto");
  assert.equal(segundo.pinned, true);
});

test("las imágenes ponen un PISO al nivel, incluso sobre el pin", () => {
  const s = "sesion-con-imagen";
  routeTurn("gracias", s); // fija trivial
  const conImagen = routeTurn("mira esto", s, "medio");
  assert.equal(conImagen.tier, "medio", "la señal no está en el texto: la trae el adjunto");
});

test("el techo del perfil solo baja, nunca sube", () => {
  assert.equal(capTier("alto", "medio"), "medio");
  assert.equal(capTier("trivial", "medio"), "trivial", "no debe encarecer un turno barato");
  assert.equal(capEffort("high", "low"), "low");
  assert.equal(capEffort(undefined, "low"), undefined);
});

test("el piso solo sube, nunca baja", () => {
  assert.equal(raiseTier("trivial", "medio"), "medio");
  assert.equal(raiseTier("alto", "medio"), "alto");
  assert.equal(raiseTier("trivial", undefined), "trivial");
});
