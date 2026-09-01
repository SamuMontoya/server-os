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

/**
 * Openverse, que sí PAGINA. Es lo que permite "esa no, otra".
 *
 * Wikipedia da UNA imagen por artículo (la de portada), así que para pasar a
 * la siguiente no sirve: hay que ir a un buscador con varios resultados.
 */
async function deOpenverse(q: string, indice: number): Promise<string | null> {
  const u =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}` +
    // SIN `category=photograph`. Parecía lo correcto —se quiere un perro
    // real, no un dibujo— pero estrangula el catálogo: para "husky siberiano"
    // deja 2 resultados donde sin él hay 240. Con dos, pedir "otra" se queda
    // sin imágenes al segundo intento. La relevancia de Openverse ya pone las
    // fotos primero.
    `&page_size=1&mature=false&page=${indice + 1}`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const j = (await r.json()) as { results?: { thumbnail?: string; url?: string }[] };
  const hit = j.results?.[0];
  return hit?.thumbnail ?? hit?.url ?? null;
}

/**
 * `indice` 0 es la primera imagen; 1, 2… son "esa no, otra".
 *
 * Wikipedia solo entra en el índice 0, porque da UNA imagen por artículo: la
 * de portada, que para "un husky" es la más certera que existe. A partir de
 * ahí manda Openverse, que pagina de verdad. Sin esta división, pedir otra
 * devolvería la misma foto de Wikipedia una y otra vez.
 */
export async function buscarImagen(q: string, indice = 0): Promise<string | null> {
  const consulta = q.trim();
  if (!consulta) return null;

  const fuentes =
    indice === 0
      ? [
          // Español primero: la consulta viene dictada en español y el
          // artículo local acierta mejor con nombres comunes.
          () => deWikipedia(consulta, "es"),
          () => deWikipedia(consulta, "en"),
          () => deOpenverse(consulta, 0),
        ]
      : [() => deOpenverse(consulta, indice - 1)];

  for (const paso of fuentes) {
    try {
      const url = await paso();
      if (url?.startsWith("https://")) return url;
    } catch {
      /* se prueba la siguiente fuente */
    }
  }
  return null;
}
