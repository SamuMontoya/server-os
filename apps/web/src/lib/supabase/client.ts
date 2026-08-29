import { createBrowserClient } from "@supabase/ssr";

/**
 * Cliente de Supabase para el NAVEGADOR (componentes "use client").
 *
 * Usa la clave publicable, que está pensada para ser pública: la seguridad real
 * la da Row Level Security en la base, no el secreto de la clave. La secreta
 * (service_role) NUNCA sale del agente.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
