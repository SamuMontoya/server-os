/**
 * Dónde volver después de entrar.
 *
 * El destino NO viaja en la URL de callback. La lista de URLs permitidas de
 * Supabase compara de forma LITERAL, así que `/auth/callback?next=%2F` no
 * coincide con lo registrado: Supabase cae al `site_url` y suelta el `?code=`
 * donde nadie lo canjea. Con cookie, la URL de callback es siempre idéntica.
 *
 * Vive aquí y no en el route handler porque lo comparten el botón (que la
 * escribe) y el callback (que la lee) — y porque Next RECHAZA cualquier export
 * que no sea suyo en un route handler: exportar esta constante desde
 * `route.ts` rompe el build con "is not a valid Route export field", y
 * `tsc --noEmit` no lo detecta.
 */

export const COOKIE_DESTINO = "hermes.destino";

/** Solo tiene que sobrevivir el viaje de ida y vuelta a Google. */
const VIDA_SEGUNDOS = 600;

/**
 * `SameSite=Lax` es imprescindible, no una preferencia: la vuelta desde Google
 * es una navegación de nivel superior desde otro sitio, y con `Strict` el
 * navegador no mandaría la cookie.
 */
export function cabeceraCookieDestino(destino: string): string {
  const seguro = typeof window !== "undefined" && window.location.protocol === "https:";
  return [
    `${COOKIE_DESTINO}=${encodeURIComponent(destino)}`,
    "Path=/",
    `Max-Age=${VIDA_SEGUNDOS}`,
    "SameSite=Lax",
    seguro ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Solo rutas internas: un destino manipulado no puede sacarte del sitio. */
export function rutaSegura(valor: string | undefined): string {
  if (!valor) return "/";
  try {
    const d = decodeURIComponent(valor);
    // Debe empezar por "/" y no por "//", que el navegador leería como host.
    if (!d.startsWith("/") || d.startsWith("//")) return "/";
    return d;
  } catch {
    return "/";
  }
}
