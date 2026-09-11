import { env } from "./env.js";

/**
 * Fecha/hora actuales, en texto listo para pegar al prompt.
 *
 * Por qué existe: el modelo no tiene reloj propio — sin esto, "hoy",
 * "mañana" o "¿qué día es?" salían de su fecha de entrenamiento, no de la
 * realidad. Se arma en CADA llamada — nunca entra al PROMPT DE SISTEMA
 * cacheable (rompería el prefijo entero en cuanto cambiara un segundo, ver
 * el comentario de `buildSystemPrompt` en `agent/system-prompt.ts`) — viaja
 * siempre por el lado NO cacheado: pegado al mensaje del turno en el chat
 * principal (`buildTurnContext`), o como bloque de `system` sin
 * `cache_control` en el reloj (`watch/rapido.ts`).
 *
 * `HERMES_TZ` es una zona IANA (ej. "America/Bogota"); vacía cae a la zona
 * del propio sistema operativo — que en un servidor puede ser UTC y no la
 * del dueño, así que vale la pena fijarla en el .env si el servidor y el
 * dueño no comparten huso horario. `HERMES_LOCATION` es texto libre para
 * mostrar ("Bogotá, Colombia") — no es GPS en vivo del reloj, es la base
 * fija del dueño; queda vacío del todo si no se configura.
 */
function partes(): { fecha: string; hora: string; zona: string } {
  const zona = env.HERMES_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ahora = new Date();
  const fecha = new Intl.DateTimeFormat("es", {
    timeZone: zona,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(ahora);
  const hora = new Intl.DateTimeFormat("es", {
    timeZone: zona,
    hour: "2-digit",
    minute: "2-digit",
  }).format(ahora);
  return { fecha, hora, zona };
}

export function contextoTemporal(): string {
  const { fecha, hora, zona } = partes();
  const lugar = env.HERMES_LOCATION ? ` — ${env.HERMES_LOCATION}` : "";
  return `Ahora mismo: ${fecha}, ${hora} (${zona})${lugar}.`;
}

/**
 * Respuesta lista para pantalla ("Miércoles 9 de septiembre de 2026,
 * 08:10.") — para el atajo de `watch.ts` que contesta preguntas de fecha/
 * hora SIN llamar al modelo. `Intl` devuelve el día de la semana en
 * minúscula; se capitaliza para que se lea como una frase.
 */
export function fechaHoraLegible(): string {
  const { fecha, hora } = partes();
  return `${fecha.charAt(0).toUpperCase()}${fecha.slice(1)}, ${hora}.`;
}

/**
 * ¿Es una pregunta de fecha/hora/día pura? Deliberadamente ANGOSTA: un
 * falso negativo cae al modelo (que ya sabe la respuesta vía
 * `contextoTemporal`, solo tarda lo normal) — un falso positivo contestaría
 * mal una pregunta distinta que solo se PARECE a esto. Sin tildes: se
 * compara ya normalizado.
 */
const RE_FECHA_HORA =
  /^(?:oye,?\s+)?(?:(?:que|cual es la)\s+(dia|hora|fecha|mes|ano)\s+(es|son|estamos|tenemos|es hoy)|en\s+que\s+(dia|mes|ano|fecha)\s+estamos|que\s+dia\s+de\s+la\s+semana\s+es)(?:\s+(?:hoy|ahora))?$/;

/** Rango Unicode de marcas diacríticas combinantes (acentos sueltos tras NFD). */
const RE_DIACRITICOS = /[̀-ͯ]/g;

export function esPreguntaFechaHora(mensaje: string): boolean {
  const normalizado = mensaje
    .toLowerCase()
    .normalize("NFD")
    .replace(RE_DIACRITICOS, "")
    .replace(/[¿?¡!.,]/g, "")
    .trim();
  return RE_FECHA_HORA.test(normalizado);
}
