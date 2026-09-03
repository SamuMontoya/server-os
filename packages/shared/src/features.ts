/**
 * Feature flags de server-os.
 *
 * El fork corre en un servidor headless que solo necesita consola, runs y
 * memoria. El resto (Estudio, juntas, inglés, voz, Linear…) no se BORRA —
 * se apaga. Borrarlo obligaría a rehacerlo cuando el Watch o el iPhone lo
 * pidan; apagarlo deja el código listo y el arranque limpio.
 *
 * Fuente única: la variable `HERMES_DISABLED`, una lista separada por comas.
 *   HERMES_DISABLED=estudio,juntas,ingles,voz,linear,vida
 *
 * El dashboard NO usa esto para decidir qué compilar: webpack no puede
 * eliminar una rama que depende de parsear un string en runtime. Para eso
 * están los `NEXT_PUBLIC_FEATURE_*` (ver apps/web/src/lib/features.ts), que
 * Next inlinea y sí permiten tree-shaking. Esta lista manda en el AGENTE.
 */

export const FEATURES = [
  "estudio", // pipeline de contenido, guiones, tomas, edición, métricas
  "juntas", // ingest, junta en vivo, copiloto, coach
  "ingles", // tutor por voz, sesiones, vocabulario
  "voz", // ElevenLabs (agente de voz y tutor)
  "linear", // tablero e issues
  "vida", // hábitos, metas, finanzas
] as const;

export type Feature = (typeof FEATURES)[number];

/** Lo que NO se puede apagar: sin esto no hay agente. */
export const CORE = ["consola", "runs", "memoria"] as const;

function parse(raw: string | undefined): Set<Feature> {
  const off = new Set<Feature>();
  for (const piece of (raw ?? "").split(",")) {
    const name = piece.trim().toLowerCase();
    if (!name) continue;
    if ((FEATURES as readonly string[]).includes(name)) off.add(name as Feature);
    else console.warn(`[features] "${name}" no es una feature conocida — se ignora`);
  }
  return off;
}

/**
 * Features apagadas en este proceso. Se resuelve UNA vez: cambiar la variable
 * exige reiniciar, que es lo correcto — media app ya montada con la feature
 * viva y media sin ella es peor que un reinicio.
 */
// Se lee por `globalThis` a propósito: este paquete es isomórfico (lo importa
// el agente Y el browser) y no tiene @types/node, así que nombrar `process`
// directo no compila. En el browser no existe y no se apaga nada.
function readEnv(): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.HERMES_DISABLED;
}

/**
 * PEREZOSO a propósito. En la primera versión esto era una const de módulo y
 * no apagaba nada: el agente importa `@hermes/shared` ANTES que `env.ts`, que
 * es quien corre dotenv — así que al evaluarse, `HERMES_DISABLED` todavía no
 * existía en process.env y el set salía vacío. Resolver en el primer uso
 * elimina la dependencia del orden de imports.
 *
 * Se cachea tras la primera lectura: cambiar la variable en caliente dejaría
 * media app con la feature viva y media sin ella, que es peor que reiniciar.
 */
let cache: ReadonlySet<Feature> | null = null;

export function disabledFeatures(): ReadonlySet<Feature> {
  if (cache === null) cache = parse(readEnv());
  return cache;
}

export function isEnabled(f: Feature): boolean {
  return !disabledFeatures().has(f);
}

/** Para el log de arranque: qué quedó encendido y qué no. */
export function featureSummary(): { on: Feature[]; off: Feature[] } {
  const off = disabledFeatures();
  return {
    on: FEATURES.filter((f) => !off.has(f)),
    off: FEATURES.filter((f) => off.has(f)),
  };
}
