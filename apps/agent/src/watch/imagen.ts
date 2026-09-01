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

// OJO: nada de `origin=*` en estas URLs. Ese parámetro pone a la API de
// Wikipedia en modo CORS anónimo, que tiene un límite de peticiones mucho más
// estricto: respondía "You are making too many requests" y caíamos al
// respaldo, que es exactamente por qué las imágenes salían imprecisas. Solo
// hace falta desde un navegador; esto es servidor.

/**
 * Wikipedia en DOS pasos, no uno.
 *
 * `generator=search` devuelve el primer resultado del BUSCADOR, que para
 * "husky" puede ser un club de hockey o una película. `opensearch` resuelve
 * primero el TÍTULO canónico del artículo —que es lo que uno escribiría en la
 * barra de direcciones— y solo entonces se le pide su imagen de portada. Esa
 * es la diferencia entre "una imagen relacionada" y "la imagen de eso".
 */
async function deWikipedia(q: string, lang: string): Promise<string | null> {
  const buscar =
    `https://${lang}.wikipedia.org/w/api.php?action=opensearch&format=json` +
    `&search=${encodeURIComponent(q)}&limit=1&namespace=0`;
  const rb = await fetch(buscar, { headers: { "User-Agent": UA } });
  if (!rb.ok) return null;
  const jb = (await rb.json()) as [string, string[], string[], string[]];
  const titulo = jb?.[1]?.[0];
  if (!titulo) return null;

  // Los de desambiguación no tienen foto propia y llevarían a una imagen que
  // no representa nada de lo que se pidió.
  if (/desambiguaci[oó]n|disambiguation/i.test(titulo)) return null;

  const pedir =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
    `&titles=${encodeURIComponent(titulo)}&prop=pageimages&piprop=thumbnail&pithumbsize=640`;
  const r = await fetch(pedir, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    query?: { pages?: Record<string, { thumbnail?: { source?: string } }> };
  };
  return Object.values(j.query?.pages ?? {})[0]?.thumbnail?.source ?? null;
}

async function deOpenverse(q: string): Promise<string | null> {
  const u =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}` +
    // Fotografías y no ilustraciones: para "muéstrame un husky" se espera un
    // perro real, no un dibujo ni un logo.
    `&page_size=1&mature=false&category=photograph`;
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
