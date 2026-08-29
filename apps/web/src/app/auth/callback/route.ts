import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { COOKIE_DESTINO, rutaSegura } from "@/lib/auth/destino";

/**
 * Callback de OAuth. Google devuelve aquí un `code` de un solo uso que se
 * canjea por una sesión; el canje deja puestas las cookies.
 *
 * La URL tiene que ser EXACTAMENTE `/auth/callback`: es lo que se registra en
 * la lista de URLs permitidas de Supabase, y esa lista compara de forma
 * literal. Nada de `?next=` — ver la nota del destino más abajo.
 */

/**
 * Ninguna respuesta de este handler puede cachearse: todas ponen o dependen de
 * cookies de sesión. Una caché intermedia podría servirle la sesión de alguien
 * a otra persona.
 */
const SIN_CACHE = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * El dashboard se sirve por IP (Tailscale o LAN) y puede haber un proxy
 * delante, así que `request.url` no siempre trae el host real. Se reconstruye
 * con `x-forwarded-*` o el usuario acabaría redirigido a un host inexistente.
 */
function urlAbsoluta(request: Request, ruta: string): string {
  const url = new URL(request.url);
  const hostReenviado = request.headers.get("x-forwarded-host");
  const protocolo = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const base = hostReenviado ? `${protocolo}://${hostReenviado}` : url.origin;
  return new URL(ruta, base).toString();
}



export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const errorOAuth = searchParams.get("error");

  // Google avisa por querystring cuando cancelas en su pantalla.
  if (errorOAuth) {
    const motivo = errorOAuth === "access_denied" ? "cancelado" : "1";
    // `error_description` es donde viene el MOTIVO real (p.ej. un secreto que
    // no cuadra con Google). Sin registrarlo, un `server_error` genérico deja
    // sin nada por dónde empezar. Va al log, nunca a la URL.
    const detalle = searchParams.get("error_description") ?? "(sin descripción)";
    const codigo = searchParams.get("error_code") ?? "";
    console.warn(
      `[auth/callback] OAuth devolvió error: ${errorOAuth}` +
        `${codigo ? ` (${codigo})` : ""} — ${detalle}`,
    );
    return NextResponse.redirect(urlAbsoluta(request, `/login?error=${motivo}`), {
      headers: SIN_CACHE,
    });
  }

  if (!code) {
    console.warn("[auth/callback] llamada sin parámetro code");
    return NextResponse.redirect(urlAbsoluta(request, "/login?error=1"), { headers: SIN_CACHE });
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      // El detalle va al log, no a la URL: los mensajes de Supabase pueden
      // revelar estado interno.
      console.error("[auth/callback] exchangeCodeForSession falló:", error);
      return NextResponse.redirect(urlAbsoluta(request, "/login?error=1"), { headers: SIN_CACHE });
    }

    const cookieDestino = request.headers
      .get("cookie")
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE_DESTINO}=`))
      ?.slice(COOKIE_DESTINO.length + 1);

    const respuesta = NextResponse.redirect(urlAbsoluta(request, rutaSegura(cookieDestino)), {
      headers: SIN_CACHE,
    });
    // De un solo uso: si se quedara, el próximo login iría al destino viejo.
    respuesta.cookies.delete(COOKIE_DESTINO);
    return respuesta;
  } catch (error) {
    console.error("[auth/callback] fallo inesperado:", error);
    return NextResponse.redirect(urlAbsoluta(request, "/login?error=1"), { headers: SIN_CACHE });
  }
}
