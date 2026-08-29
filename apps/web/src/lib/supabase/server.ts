import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Cliente de Supabase para el SERVIDOR: Server Components y route handlers.
 *
 * Actúa en nombre del usuario autenticado leyendo su sesión de las cookies, así
 * que respeta RLS. En Next 15 `cookies()` es asíncrona, de ahí el async.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch (error) {
            // Los Server Components no pueden escribir cookies; ahí es
            // esperado, porque el refresco lo hace el middleware. Pero en un
            // route handler es un fallo REAL —una sesión que no se guardó— y
            // sin este aviso sería invisible.
            console.warn("[supabase/server] no se pudieron escribir las cookies:", error);
          }
        },
      },
    },
  );
}
