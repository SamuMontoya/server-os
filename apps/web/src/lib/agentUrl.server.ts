import { createClient } from "@supabase/supabase-js";

/**
 * URL pública vigente del agente, para las rutas de servidor (proxies de
 * /api/claude-limits y /api/claude-usage). Estas rutas NO pueden usar
 * localStorage (no hay browser), así que resuelven aparte: primero
 * `remote_config` (la misma tabla que publica el quick tunnel — ver
 * lib/auth/agentUrlSync.ts para el equivalente de cliente), con
 * NEXT_PUBLIC_HERMES_URL como respaldo si la consulta falla por lo que sea.
 *
 * Usa el service role: estas rutas corren en el servidor de Vercel, nunca
 * llegan al browser, y la RLS de `remote_config` (solo `authenticated`) no
 * debería depender de que HAYA un usuario logueado en este contexto —
 * el middleware ya exige sesión antes de llegar aquí, pero resolver la URL
 * del agente no es un dato del usuario, es config de despliegue.
 */

const FALLBACK_URL = (process.env.NEXT_PUBLIC_HERMES_URL || "http://localhost:8650").replace(
  /\/$/,
  "",
);

const TTL_MS = 60_000;
let cache: { at: number; url: string } | null = null;

export async function resolveAgentUrl(): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.url;

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) {
    cache = { at: now, url: FALLBACK_URL };
    return FALLBACK_URL;
  }

  try {
    const supabase = createClient(supaUrl, supaKey);
    const { data, error } = await supabase
      .from("remote_config")
      .select("value")
      .eq("key", "agent_public_url")
      .maybeSingle();
    const url = !error && data?.value ? data.value.replace(/\/$/, "") : FALLBACK_URL;
    cache = { at: now, url };
    return url;
  } catch {
    cache = { at: now, url: FALLBACK_URL };
    return FALLBACK_URL;
  }
}
