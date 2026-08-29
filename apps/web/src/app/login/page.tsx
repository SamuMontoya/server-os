import { redirect } from "next/navigation";
import { BotonGoogle } from "@/components/auth/BotonGoogle";
import { createClient } from "@/lib/supabase/server";
import { OWNER } from "@/lib/owner";

/**
 * Puerta de entrada del dashboard.
 *
 * Vive FUERA del AppShell: el shell monta la consola, los polls y la sesión de
 * voz, y nada de eso debe arrancar antes de haber entrado.
 */

export const dynamic = "force-dynamic";

const MOTIVOS: Record<string, string> = {
  cancelado: "Cancelaste el acceso en la pantalla de Google.",
  "1": "No se pudo completar el acceso. Inténtalo otra vez.",
  sesion: "Tu sesión expiró. Vuelve a entrar.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  // Ya con sesión, esta página no tiene sentido.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect(next && next.startsWith("/") ? next : "/");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xs font-semibold tracking-hero uppercase">
          Hermes<span className="text-violet"> OS</span>
        </h1>
        <p className="mt-6 text-base text-text-dim">
          Hola, {OWNER}. Entra para abrir tu consola.
        </p>

        <div className="mt-8">
          <BotonGoogle destino={next && next.startsWith("/") ? next : "/"} />
        </div>

        {error && (
          <p className="mt-4 text-2xs text-amber">{MOTIVOS[error] ?? MOTIVOS["1"]}</p>
        )}

        <p className="mt-10 text-2xs leading-relaxed text-text-faint">
          Este dashboard controla un agente con acceso real a tu máquina. El acceso está
          restringido a tu cuenta.
        </p>
      </div>
    </main>
  );
}
