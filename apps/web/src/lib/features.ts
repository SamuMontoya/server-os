/**
 * Feature flags del dashboard — versión de BUILD, no de runtime.
 *
 * El agente resuelve sus features leyendo `HERMES_DISABLED` en caliente
 * (packages/shared/src/features.ts). Aquí no sirve: webpack no puede eliminar
 * una rama cuya condición depende de parsear un string en tiempo de
 * ejecución, así que las vistas apagadas seguirían dentro del bundle y el
 * `next build` seguiría pidiendo la misma memoria.
 *
 * Por eso cada feature tiene su propia `NEXT_PUBLIC_FEATURE_*`. Next las
 * INLINEA como literales al compilar, la comparación queda en `"0" !== "0"`
 * y webpack tira la rama entera con su import dinámico.
 *
 * Consecuencia práctica: encender o apagar una feature del dashboard exige
 * recompilar. En el servidor eso es lo correcto — es justamente lo que hace
 * que el build entre en 3.2 GB de RAM.
 */

// Se escriben COMPLETAS y literales (nada de `process.env["FEATURE_" + x]`):
// el inlineado de Next funciona por coincidencia textual exacta.
export const FEAT = {
  estudio: process.env.NEXT_PUBLIC_FEATURE_ESTUDIO !== "0",
  ingles: process.env.NEXT_PUBLIC_FEATURE_INGLES !== "0",
  vida: process.env.NEXT_PUBLIC_FEATURE_VIDA !== "0",
  agenda: process.env.NEXT_PUBLIC_FEATURE_AGENDA !== "0",
  voz: process.env.NEXT_PUBLIC_FEATURE_VOZ !== "0",
  juntas: process.env.NEXT_PUBLIC_FEATURE_JUNTAS !== "0",
  gestos: process.env.NEXT_PUBLIC_FEATURE_GESTOS !== "0",
} as const;

export type WebFeature = keyof typeof FEAT;
