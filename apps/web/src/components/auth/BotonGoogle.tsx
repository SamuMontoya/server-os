"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cabeceraCookieDestino } from "@/lib/auth/destino";

/**
 * Botón de "Continuar con Google".
 *
 * Client component: necesita el `origin` del navegador para armar la URL de
 * callback, y el flujo de OAuth tiene que arrancar con una interacción real.
 */



export function BotonGoogle({ destino }: { destino?: string }) {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function entrarConGoogle() {
    setCargando(true);
    setError(null);
    if (destino) document.cookie = cabeceraCookieDestino(destino);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    if (error) {
      // Solo se llega aquí si falla ANTES de salir del sitio. Si el redirect a
      // Google funciona, esta línea no se ejecuta.
      console.error("[login] signInWithOAuth falló:", error);
      setError("No se pudo iniciar el proceso. Vuelve a intentarlo.");
      setCargando(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <button
        type="button"
        onClick={entrarConGoogle}
        disabled={cargando}
        className="flex w-full cursor-pointer items-center justify-center gap-3 rounded-sm border border-line bg-panel-2 px-4 py-3 text-sm text-text transition-colors hover:border-line-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {cargando ? (
          <span className="pulse-dot">◌</span>
        ) : (
          // Marca de Google: no se puede recolorear ni deformar, por eso va con
          // sus colores originales sobre el panel y no en violeta.
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
            />
            <path
              fill="#FBBC05"
              d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
            />
          </svg>
        )}
        {cargando ? "Conectando…" : "Continuar con Google"}
      </button>
      {error && <p className="text-2xs text-red">{error}</p>}
    </div>
  );
}
