"use client";

import { createClient } from "@/lib/supabase/client";
import { setHermesUrl } from "@/lib/hermes";

/**
 * Resuelve la URL PÚBLICA vigente del agente y la aplica como override (ver
 * `setHermesUrl`/`getHermesUrl` en `lib/hermes.ts`), para que el portal en
 * Vercel siga hablando con el agente aunque la URL horneada en build
 * (`NEXT_PUBLIC_HERMES_URL`) haya quedado vieja o inalcanzable.
 *
 * Por qué existe: el agente se expone con un quick tunnel de cloudflared
 * (`scripts/hermes-tunnel-linux.sh`), cuya URL ROTA en cada reinicio del
 * túnel. Hornearla en el build serviría para UN deploy y se rompería en el
 * siguiente reinicio del servidor de casa. En vez de eso, el túnel publica
 * la URL vigente en `remote_config` (tabla existente, RLS: cualquier usuario
 * autenticado puede leerla) y el portal la resuelve en tiempo de ejecución.
 *
 * Se sondea cada POLL_MS en vez de suscribirse a Realtime porque el cambio es
 * raro (solo ocurre si el túnel se reinicia — un reboot del servidor, no una
 * conversación normal) y evita depender de Realtime habilitado en la tabla.
 */

const POLL_MS = 2 * 60_000;
let iniciado = false;

async function resolverUrl(): Promise<void> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("remote_config")
      .select("value")
      .eq("key", "agent_public_url")
      .maybeSingle();
    if (!error && data?.value) setHermesUrl(data.value);
  } catch {
    // Sin red o sin sesión todavía: se mantiene lo que ya había (el default
    // horneado en build, o el último valor bueno resuelto).
  }
}

/** Idempotente: un doble montaje (StrictMode) no debe abrir dos pollers. */
export function iniciarAgentUrlSync(): void {
  if (iniciado || typeof window === "undefined") return;
  iniciado = true;
  void resolverUrl();
  setInterval(() => void resolverUrl(), POLL_MS);
}
