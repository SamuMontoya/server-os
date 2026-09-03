import { test } from "node:test";
import assert from "node:assert/strict";

import { capEffort, capTier, classify, raiseTier, routeTurn } from "./router.js";

/**
 * Tests del router de costo.
 *
 * Por qué existen: el router decide con qué modelo abre cada conversación, y
 * equivocarse por arriba se paga en la ventana de 5 h — es el componente donde
 * un falso positivo cuesta plata de verdad. Estaba sin tests y una regresión
 * silenciosa (un verbo de más en la lista) no la habría cachado nadie hasta
 * ver la factura.
 *
 * Los mensajes de abajo NO son inventados: son mensajes REALES del dueño,
 * copiados de conversaciones, y cada bloque documenta el falso positivo
 * concreto que se está evitando. Si alguien vuelve a meter `analiz` o `.md` en
 * las listas de `deep`, estos tests se caen.
 */

test("los saludos y las continuaciones caen en el nivel barato", () => {
  for (const m of ["hola", "gracias", "listo", "ok", "dale", "Sigue", "continúa", "TLDR"]) {
    assert.equal(classify(m).tier, "light", `"${m}" debería ser light`);
  }
});

test("una pregunta de estado corta se responde con haiku", () => {
  for (const m of [
    "Que sub carpetas tienes? TLDR",
    "Ya está todo arriba? TLDR",
    "¿qué tengo pendiente hoy?",
    "cómo va el proyecto?",
    "Con el 1 no serviría?",
  ]) {
    assert.equal(classify(m).tier, "light", `"${m}" debería ser light`);
  }
});

test("el nivel barato SÍ se alcanza (antes no se disparaba nunca)", () => {
  // La regresión histórica: `light` existía en la tabla de niveles y en la
  // práctica clasificaba 0 de 37 mensajes reales, porque las comprobaciones de
  // trabajo iban primero y cualquier verbo de la lista larga lo adelantaba.
  const reales = ["TLDR", "Sigue", "Que ponemos?", "Ya está todo arriba? TLDR"];
  const barato = reales.filter((m) => classify(m).tier === "light");
  assert.equal(barato.length, reales.length, "el nivel barato volvió a quedar muerto");
});

test("pedir que se ARREGLE código sí llega a opus", () => {
  for (const m of [
    "Arregla los puntos relacionados con el consumo y la página de laboratorio",
    "Continúa, soluciona los agujeros",
    "refactoriza este módulo",
    "implementa el endpoint de métricas",
    "corrige el bug del scroll",
    "optimiza la query que tarda 4s",
  ]) {
    assert.equal(classify(m).tier, "deep", `"${m}" debería ser deep`);
  }
});

test("un archivo o una ruta de FUENTE llega a opus", () => {
  for (const m of [
    "revisa apps/web/src/app/laboratorio/page.tsx",
    "qué hace router.ts",
    "mira este bloque ```const x = 1```",
    "explícame apps/agent/src/agent",
  ]) {
    assert.equal(classify(m).tier, "deep", `"${m}" debería ser deep`);
  }
});

test("consultar y orquestar es sonnet, no opus", () => {
  // El encargo explícito del dueño: "la orquestación que hace entre funciones
  // y comandos no debe ser de opus sino de sonnet". Estos siete verbos
  // (analiz/audit/investig/compar/planific/resuelv/diseñ) eran 4 de los 5
  // turnos que abrían en opus/high sobre mensajes reales.
  for (const m of [
    "Analiza el repo de server-os y dime dónde se está yendo el consumo",
    "auditate a ti mismo brevemente y si todo bien commit y push",
    "Investiga en las carpetas como se llama la api de voz gratuita",
    "compara las dos alternativas de VPS",
    "planifica la semana",
    "resuelve cuál conviene",
    "diseña la pantalla de resultados",
  ]) {
    assert.equal(classify(m).tier, "standard", `"${m}" no debería ser deep: ${m}`);
  }
});

test("el markdown del vault NO es señal de código", () => {
  // `.md` es el formato NATIVO del producto (todo el vault de Obsidian). Con
  // `md` en los marcadores de código, hablar de una nota abría el hilo en
  // opus/high — y como el nivel queda FIJO por sesión, UNA mención dejaba la
  // conversación entera ahí.
  for (const m of [
    "qué dice mi nota de finanzas.md",
    "resume mi nota de perfil.md",
    "recuérdame la reunión de mañana.md",
  ]) {
    assert.notEqual(classify(m).tier, "deep", `"${m}" no debería ser deep`);
  }
});

test("una ruta que no es de código tampoco lo es", () => {
  // Con el patrón de dos segmentos, "/descargas/reunion" clasificaba como
  // código. Ahora la ruta pide tres segmentos.
  assert.notEqual(classify("mira el video que subí a /descargas/reunion").tier, "deep");
});

test("preguntar POR una migración no es hacerla", () => {
  const m =
    "Ok, no problem. Ahora quiero que sigamos con el desarrollo que estamos haciendo " +
    "en Kreanding para la oferta 1. En que quedamos ayer y que sigue? Creo que solo " +
    "hicimos la migración, no? TLDR";
  assert.equal(classify(m).tier, "standard", "'hicimos la migración' es una consulta");
});

test("correr comandos es orquestación, no autoría", () => {
  // commit/push/pnpm son exactamente el caso que el dueño pidió mover a sonnet.
  for (const m of ["commit y push en samuel", "corre pnpm test", "haz el deploy"]) {
    assert.notEqual(classify(m).tier, "deep", `"${m}" no debería ser deep`);
  }
});

test("un mensaje largo no es, por largo, trabajo de opus", () => {
  // La regla "más de 60 palabras → deep" medía el estilo de escritura del
  // dueño (párrafos largos y discursivos), no la dificultad de la tarea.
  const largo = ("pregunta sobre el estado de las cosas y del proyecto ".repeat(9) + "gracias")
    .trim();
  assert.ok(largo.split(/\s+/).length > 60, "el caso de prueba tiene que pasar de 60 palabras");
  assert.equal(classify(largo).tier, "standard");
});

test("el nivel queda FIJO por sesión (protege el caché de prompt)", () => {
  const s = "sesion-fija-1";
  const primero = routeTurn("Arregla el bug del login", s);
  assert.equal(primero.tier, "deep");
  assert.equal(primero.pinned, false);
  // Un "gracias" a mitad del hilo no debe bajar el modelo: cambiar de modelo
  // tira el prefijo cacheado y re-cachear cuesta más que lo ahorrado.
  const segundo = routeTurn("gracias", s);
  assert.equal(segundo.tier, "deep");
  assert.equal(segundo.pinned, true);
});

test("las imágenes ponen un PISO al nivel, incluso sobre el pin", () => {
  const s = "sesion-con-imagen";
  routeTurn("gracias", s); // fija light
  const conImagen = routeTurn("mira esto", s, "standard");
  assert.equal(conImagen.tier, "standard", "la señal no está en el texto: la trae el adjunto");
});

test("el techo del perfil solo baja, nunca sube", () => {
  assert.equal(capTier("deep", "standard"), "standard");
  assert.equal(capTier("light", "standard"), "light", "no debe encarecer un turno barato");
  assert.equal(capEffort("high", "low"), "low");
  assert.equal(capEffort(undefined, "low"), undefined);
});

test("el piso solo sube, nunca baja", () => {
  assert.equal(raiseTier("light", "standard"), "standard");
  assert.equal(raiseTier("deep", "standard"), "deep");
  assert.equal(raiseTier("light", undefined), "light");
});
