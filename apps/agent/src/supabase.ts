import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * Timeout global para TODAS las llamadas a Supabase (memorias, conocimiento,
 * preferencias, proyectos espejados…). Sin esto un fetch colgado (red caída,
 * Supabase lento) bloqueaba el turno del chat SIN LÍMITE — `runAgentTurn`
 * espera estas llamadas antes de mandar la primera palabra, así que el
 * síntoma era el orbe pegado indefinidamente, no una respuesta lenta.
 *
 * postgrest-js CAPTURA los errores de fetch (incluido AbortError) y los
 * devuelve como `{ error }` en vez de tirar la excepción hacia arriba: los
 * call sites que ya ignoran `error` y usan `data ?? []`/`{}` degradan solos,
 * sin cambios adicionales.
 */
const SUPABASE_TIMEOUT_MS = 4000;

function timeoutFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  const outer = init?.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Cliente con service role (solo server-side). Si no hay credenciales,
// el server sigue funcionando en modo degradado (sin memoria persistente).
let client: SupabaseClient | null = null;

if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { fetch: timeoutFetch },
  });
} else {
  console.warn(
    "[hermes] Supabase no configurado — memorias y presencia deshabilitadas. " +
      "Completa NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en .env",
  );
}

export const supabase = client;
export const hasSupabase = () => client !== null;
