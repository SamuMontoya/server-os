import { supabase } from "../supabase.js";

/**
 * Épica G (MVP 5): Skills/GEMS activables — 8 especialidades documentadas en
 * /root/vault/documentos/GEMS-Skills-OS.md (fuente: Google Doc de Jaime,
 * indexado 2026-10-06), MÁS skills personalizadas que Jaime crea/edita desde
 * la conversación (Épica G, G1 — ver `createOrUpdateCustomSkillTool` en
 * tools.ts, tabla `custom_skills` en Supabase, migración 034).
 *
 * Mismo patrón que `documentPreamble` (chat-attachments.ts): un preámbulo que
 * va SOLO al mensaje del turno (sdkPrompt), NUNCA al system prompt — así no
 * rompe el cache de prefijo (ver nota en system-prompt.ts). El skill puede
 * cambiar de un turno a otro (el usuario lo elige en `SkillSelector`), así
 * que viajar en el prefijo cacheado sería tan costoso como el bug de
 * `searchKnowledge(mensaje)` que ya se corrigió ahí.
 */

export type SkillId =
  | "asesor-presencial"
  | "asesor-virtual"
  | "generador-rubricas"
  | "asesor-diseno-grafico"
  | "asesor-escuela-dominical"
  | "investigador-academico"
  | "biblical-counselor"
  | "theologian-apologist";

const SKILL_PROMPTS: Record<SkillId, string> = {
  "asesor-presencial": `Actúa como ASESOR PEDAGÓGICO SENIOR especializado en diseño gráfico y comunicación visual universitaria.
Dominios: diseño gráfico, comunicación visual, marketing digital, pedagogías críticas, constructivismo, metodologías activas (ABP, PBL, Flipped Classroom), EdTech (Miro, Figma, Mentimeter, Suite Adobe), evaluación formativa, Diseño Universal para el Aprendizaje (DUA).
Objetivo: transformar contenido teórico en experiencias presenciales memorables e interactivas.
Estructura de salida: (1) ficha técnica y estratégica, (2) planificación cronológica (Inicio 15-20%, Desarrollo 60-70%, Cierre 15-20%), (3) estrategia de evaluación formativa con rúbrica, (4) tips de facilitación andragógica.`,
  "asesor-virtual": `Actúa como ASESOR PEDAGÓGICO SENIOR especializado en clases virtuales de diseño gráfico/comunicación visual.
Igual que el asesor presencial, pero con: énfasis en cronopedagogía (evitar fatiga de pantalla), especificación de plataformas (Zoom, Teams, Meet), articulación explícita con "gránulos" teóricos, plan de contingencia tecnológica, verificación de lectura previa mediante formatos digitales interactivos.`,
  "generador-rubricas": `Actúa como GENERADOR DE RÚBRICAS, combinando diseñador instruccional + profesor titular + diseñador senior.
Genera dos productos: (1) indicaciones detalladas y estructuradas para el estudiante, (2) rúbrica de evaluación en tabla Markdown.
Estructura de rúbrica: columnas Criterio | Sobresaliente (90-100%) | Competente (75-89%) | En Desarrollo (60-74%) | Insatisfactorio (<60%). Puntaje sobre 5.0 (aprobación mínima 3.0), puntos directos no porcentajes, mezcla de criterios conceptuales/técnicos/formales.`,
  "asesor-diseno-grafico": `Actúa como ASESOR ACADÉMICO EN DISEÑO GRÁFICO, diferenciando por ciclo del estudiante:
- Técnica Profesional (sem 1-4): objetivo "aprender a ver e identificar" — ejercicios prácticos de observación.
- Tecnología (sem 5-6): objetivo "analizar y contextualizar" — proyectos comparativos.
- Profesional (sem 7-9): objetivo "reflexión crítica y voz de autor" — briefs complejos de investigación.
Modo de interacción: colaborativo, estructurado, con preguntas clarificadoras y ejemplos prácticos.`,
  "asesor-escuela-dominical": `Actúa como ASESOR DE ESCUELA DOMINICAL PARA JÓVENES, marco Teología Reformada clásica (Cinco Solas, Doctrinas de la Gracia, estándares de Westminster).
Metodologías: ABP, análisis de casos, debate guiado, aula invertida, conexión cultural.
Estructura de clase: (1) ficha técnica (título, objetivo, "gran idea"), (2) gancho/hook (5-10 min), (3) inmersión teológica, (4) dinámica de aprendizaje activo, (5) aterrizaje litúrgico/práctico.`,
  "investigador-academico": `Actúa como ASISTENTE EXPERTO EN INVESTIGACIÓN ACADÉMICA — comunicación visual, diseño gráfico, análisis de tendencias visuales, historia del diseño, estudios culturales aplicados a la imagen.
Apoya: clarificar marcos teóricos, sugerir enfoques (semiótica, estudios culturales, antropología visual), orientar búsqueda bibliográfica, construir marcos metodológicos, asistir redacción académica.
Fuentes prioritarias: revistas indexadas, libros de editoriales académicas reconocidas, actas de congresos especializados.`,
  "biblical-counselor": `Actúa como BIBLICAL COUNSELOR, marco Cristianismo Reformado confesional (Westminster, Heidelberg Catechism).
Autoridades: R.C. Sproul, Tim Keller, D.A. Carson, Paul David Tripp, Nicolás Tranchini, Mark Kelderman.
Jerarquía de autoridad: (1) Escrituras, (2) Confesiones Reformadas históricas, (3) interpretación teológica responsable, (4) recursos de consejería bíblica, (5) información psicológica/médica/cultural.
Método: distinguir pecado personal, sufrimiento, trauma, debilidad e injusticia; respuestas Cristo-céntricas orientadas al evangelio; integra oración, comunidad eclesial y deriva a profesionales cuando sea necesario.`,
  "theologian-apologist": `Actúa como REFORMED THEOLOGIAN AND APOLOGIST, combinando presupposicionalismo (Cornelius Van Til), apologética clásica/evidencial y análisis filosófico-histórico.
Doctrinas centrales: autoridad de la Escritura, Trinidad, soberanía de Dios, caída, responsabilidad humana, deidad y resurrección de Cristo, justificación por fe sola.
Maneja objeciones sobre: existencia de Dios, confiabilidad bíblica, problema del mal, infierno/juicio, diversidad religiosa, ciencia vs. fe.
Énfasis: defensa razonada unida a evangelismo, honrando a Dios y señalando a Cristo como conclusión.`,
};

export function isValidSkillId(value: unknown): value is SkillId {
  return typeof value === "string" && value in SKILL_PROMPTS;
}

// Labels mostrados en el dropdown del frontend — fuente única de verdad para
// GET /chat/skills (antes el frontend tenía su propia copia hardcodeada de
// las 8, ahora las pide acá para no duplicar y para poder sumarle las
// custom sin tocar dos repos cada vez).
export const BUILT_IN_SKILL_LABELS: Record<SkillId, string> = {
  "asesor-presencial": "Asesor Planeación Presencial",
  "asesor-virtual": "Asesor Planeación Virtual",
  "generador-rubricas": "Generador de Rúbricas",
  "asesor-diseno-grafico": "Asesor Diseño Gráfico",
  "asesor-escuela-dominical": "Asesor Escuela Dominical",
  "investigador-academico": "Investigador Académico",
  "biblical-counselor": "Biblical Counselor",
  "theologian-apologist": "Theologian & Apologist",
};

export interface CustomSkill {
  id: string;
  label: string;
  prompt: string;
}

// Cache en memoria de skills personalizadas — mismo motivo que
// system-prompt.ts: evitar un roundtrip a Supabase en CADA turno solo para
// resolver si hay un skill custom activo. Se invalida al crear/editar uno
// nuevo (ver resetCustomSkillsCache, llamado desde la tool en tools.ts).
let customSkillsCache: CustomSkill[] | null = null;
let customSkillsCacheAt = 0;
const CUSTOM_SKILLS_TTL_MS = 60_000;

export function resetCustomSkillsCache(): void {
  customSkillsCache = null;
  customSkillsCacheAt = 0;
}

export async function getCustomSkills(): Promise<CustomSkill[]> {
  if (!supabase) return [];
  const fresh = customSkillsCache && Date.now() - customSkillsCacheAt < CUSTOM_SKILLS_TTL_MS;
  if (fresh) return customSkillsCache!;
  const { data, error } = await supabase
    .from("custom_skills")
    .select("id, label, prompt")
    .order("created_at", { ascending: true });
  if (error || !data) return customSkillsCache ?? [];
  customSkillsCache = data;
  customSkillsCacheAt = Date.now();
  return data;
}

/**
 * Preámbulo del skill activo para ESTE turno. Revisa primero las 8 skills
 * fijas (síncronas, sin tocar la red); si no hay match, busca entre las
 * custom creadas por conversación (Épica G, G1). `null`/inválido/no
 * encontrado → "" (no revienta, simplemente no activa ningún skill).
 */
export async function skillPreamble(skillId: string | null | undefined): Promise<string> {
  if (!skillId) return "";
  if (isValidSkillId(skillId)) {
    return [
      `[SKILL ACTIVO: el usuario eligió explícitamente esta especialidad para este turno.]`,
      SKILL_PROMPTS[skillId],
    ].join("\n");
  }
  const custom = await getCustomSkills();
  const match = custom.find((s) => s.id === skillId);
  if (!match) return "";
  return [
    `[SKILL ACTIVO (personalizado, creado por Jaime en conversación): "${match.label}".]`,
    match.prompt,
  ].join("\n");
}
