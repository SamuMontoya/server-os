/**
 * Primera imagen de internet para una consulta ("muéstrame un husky").
 *
 * Sin API key ni cuenta: Wikipedia primero (rápida, imágenes limpias y de
 * portada, que para "un husky" es exactamente lo que se quiere) y Openverse
 * de respaldo para lo que Wikipedia no tenga como artículo.
 *
 * Devuelve SIEMPRE https: el reloj no carga http sin desactivar ATS, y no
 * merece la pena abrir esa puerta por esto.
 */

const UA = "hermes-os-watch/1.0 (https://github.com/SamuMontoya/server-os)";

async function deWikipedia(q: string, lang: string): Promise<string | null> {
  const u =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=1` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=640`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    query?: { pages?: Record<string, { thumbnail?: { source?: string } }> };
  };
  const pages = Object.values(j.query?.pages ?? {});
  return pages[0]?.thumbnail?.source ?? null;
}

async function deOpenverse(q: string): Promise<string | null> {
  const u =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}` +
    `&page_size=1&mature=false`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const j = (await r.json()) as { results?: { thumbnail?: string; url?: string }[] };
  const hit = j.results?.[0];
  return hit?.thumbnail ?? hit?.url ?? null;
}

export async function buscarImagen(q: string): Promise<string | null> {
  const consulta = q.trim();
  if (!consulta) return null;
  // Español primero: la consulta viene dictada en español y el artículo local
  // suele acertar mejor con nombres comunes de animales y cosas.
  for (const paso of [
    () => deWikipedia(consulta, "es"),
    () => deWikipedia(consulta, "en"),
    () => deOpenverse(consulta),
  ]) {
    try {
      const url = await paso();
      if (url?.startsWith("https://")) return url;
    } catch {
      /* se prueba la siguiente fuente */
    }
  }
  return null;
}
