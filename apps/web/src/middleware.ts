import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Puerta de autenticación del dashboard.
 *
 * Hace DOS cosas, y la primera es fácil de olvidar:
 *
 *  1. Refresca la sesión. `@supabase/ssr` renueva el token aquí y reescribe las
 *     cookies; sin este paso la sesión caduca sola y el usuario se cae solo a
 *     los pocos minutos sin motivo aparente.
 *  2. Protege las rutas.
 *
 * ⚠️ Esto es una comprobación de EXPERIENCIA DE USUARIO, no la barrera de
 * seguridad. La barrera real es la `HERMES_API_KEY` que exige el agente y RLS
 * en Supabase: alguien que llame directo a `:8650` no pasa por aquí.
 */

/** Públicas siempre. Se resuelven en código, no excluyéndolas del matcher. */
const PUBLICAS = [
  // NO NEGOCIABLE: aquí es donde `exchangeCodeForSession` crea la sesión.
  // Cuando llega esta petición todavía no hay cookie; protegerla redirigiría a
  // /login quemando el `code`, que es de un solo uso. El síntoma sería "el
  // botón de Google no hace nada", sin ningún error en los logs.
  "/auth/callback",
  "/login",
];

/**
 * Quién puede entrar. Sin esto, CUALQUIER cuenta de Google que complete el
 * flujo tendría consola sobre un agente con acceso real a la máquina — Google
 * autentica quién eres, no si tú tienes permiso.
 *
 * Vacío = se niega a todos, a propósito: fallar cerrado es lo correcto cuando
 * lo que se protege es una shell.
 */
function correosPermitidos(): string[] {
  return (process.env.NEXT_PUBLIC_HERMES_ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function esPublica(pathname: string): boolean {
  const ruta = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return PUBLICAS.includes(ruta);
}

export async function middleware(request: NextRequest) {
  // Las públicas salen ANTES de construir el cliente de Supabase. En
  // /auth/callback importa: ahí las cookies llevan el verificador de PKCE que
  // el handler necesita intacto, y un getUser() sin sesión puede tocarlas.
  // Además evita una llamada de red por cada carga del login.
  if (esPublica(request.nextUrl.pathname)) return NextResponse.next({ request });

  // La respuesta se crea ANTES del cliente: `setAll` escribe las cookies del
  // token refrescado sobre este objeto, y devolver otro las perdería.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() y no getSession(): getUser valida el token contra Supabase.
  // getSession solo lee la cookie, que el navegador puede haber manipulado.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const permitidos = correosPermitidos();
  const correo = (user.email || "").toLowerCase();
  if (!permitidos.includes(correo)) {
    // Autenticado pero no autorizado. Se cierra la sesión para no dejarlo en un
    // bucle de redirecciones con una sesión válida que nunca sirve de nada.
    console.warn(`[auth] acceso denegado a ${correo || "(sin correo)"}`);
    await supabase.auth.signOut();
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "?error=denegado";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /**
     * Todo menos estáticos e imágenes. Las rutas de `/api` SÍ entran: son las
     * que leen los límites del plan y hablan con el agente.
     *
     * `assets/` va aparte, y no por extensión: ahí vive el material del orbe,
     * que son DOS archivos que se acompañan —el atlas (.webp, ya excluido) y
     * movimiento.json—. Sin esto el .json caía en la puerta de auth y volvía
     * como un 307 al login, así que el orbe cargaba la textura pero nunca el
     * movimiento y se quedaba clavado sin animar. Son datos de una animación:
     * no hay nada que proteger en ellos.
     */
    "/((?!_next/static|_next/image|favicon.ico|mediapipe|assets/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
