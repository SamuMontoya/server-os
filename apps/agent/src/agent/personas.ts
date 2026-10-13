import { supabase } from "../supabase.js";

/**
 * Épica H (MVP 6): Personas/"sombreritos" — identidades completas y
 * persistentes con su propio historial de chats, preamble base, y
 * opcionalmente un skill por defecto (auto-aplicado al activarla).
 *
 * Mismo patrón async que skillPreamble (ver skills.ts): personaPreamble()
 * busca en custom_personas (tabla Supabase), con cache en memoria TTL 60s.
 * Cache invalidable al crear/editar una persona.
 */

export interface Persona {
  id: string;
  label: string;
  avatar_emoji_or_url?: string;
  preamble_base: string;
  default_skill_id?: string;
  created_at?: string;
  updated_at?: string;
}

// Cache en memoria — mismo motivo que custom_skills: evitar un roundtrip a
// Supabase en cada turno solo para resolver si hay una persona activa.
let personasCache: Persona[] | null = null;
let personasCacheAt = 0;
const PERSONAS_TTL_MS = 60_000;

export function resetPersonasCache(): void {
  personasCache = null;
  personasCacheAt = 0;
}

export async function getPersonas(): Promise<Persona[]> {
  if (!supabase) return [];
  const fresh = personasCache && Date.now() - personasCacheAt < PERSONAS_TTL_MS;
  if (fresh) return personasCache!;
  const { data, error } = await supabase
    .from("personas")
    .select("id, label, avatar_emoji_or_url, preamble_base, default_skill_id, created_at, updated_at")
    .order("created_at", { ascending: true });
  if (error || !data) return personasCache ?? [];
  personasCache = data;
  personasCacheAt = Date.now();
  return data;
}

export async function getPersonaById(personaId: string): Promise<Persona | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("personas")
    .select("id, label, avatar_emoji_or_url, preamble_base, default_skill_id, created_at, updated_at")
    .eq("id", personaId)
    .maybeSingle();
  return data || null;
}

/**
 * Preámbulo de la persona activa para ESTE turno. Busca en `personas` (tabla
 * Supabase), con cache en memoria TTL. Null/inválido/no encontrado → ""
 * (no revienta, simplemente no activa ninguna persona).
 */
export async function personaPreamble(personaId: string | null | undefined): Promise<string> {
  if (!personaId) return "";
  const personas = await getPersonas();
  const match = personas.find((p) => p.id === personaId);
  if (!match) return "";
  return [
    `[PERSONA ACTIVA (identidad persistente): "${match.label}".]`,
    match.preamble_base,
  ].join("\n");
}
