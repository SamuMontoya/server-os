import type { ImageSearchFn } from "./types.js";

/**
 * Foto REAL de una persona (o cualquier entidad con artículo propio), vía
 * Wikipedia — no es un proveedor intercambiable más en el registro de
 * `index.ts`, es la ruta que toma `watch/imagen.ts` cuando el clasificador
 * detecta que piden a alguien identificable por nombre.
 *
 * Por qué Pexafy no sirve para esto: agrega bancos de fotos LIBRES (Unsplash,
 * Pexels, Pixabay...), y esos bancos no incluyen gente real reconocible por
 * licencia — un fotógrafo puede publicar su foto de un atardecer sin pedirle
 * permiso a nadie, pero no la de una persona identificable. Por eso Pexafy
 * siempre traía algo "relacionado" (alguien pateando un balón, no el jugador
 * pedido) y nunca a la persona en sí. El artículo de Wikipedia de alguien
 * conocido, en cambio, casi siempre trae su foto real en el resumen —
 * subida ahí justamente por tener los derechos en regla.
 *
 * UNA sola llamada, no dos: la primera versión buscaba el título con
 * `opensearch` y LUEGO pedía su foto con `pageimages` — dos round-trips
 * secuenciales. `generator=search` hace de las dos cosas una sola consulta
 * (busca Y trae `pageimages` de lo que encontró en el mismo request),
 * verificado en vivo contra "Shakira", "Cristiano Ronaldo" y "Gustavo
 * Petro": mismo artículo y misma foto que el camino en dos pasos, con la
 * mitad de la latencia de red.
 *
 * Español primero, inglés de respaldo: no por preferencia sino porque hay
 * más gente (sobre todo si no es hispanohablante) con mejor cobertura de
 * fotos en penwiki que en eswiki — probar los dos solo cuesta la latencia
 * extra cuando el primero de verdad no tiene nada, no en el caso común.
 */
const IDIOMAS = ["es", "en"];

async function buscarEn(idioma: string, query: string, ancho: number): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "1",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: String(ancho),
    format: "json",
  });
  const r = await fetch(`https://${idioma}.wikipedia.org/w/api.php?${params}`);
  if (!r.ok) return null;
  const data = (await r.json()) as {
    query?: { pages?: Record<string, { thumbnail?: { source?: string } }> };
  };
  const pagina = Object.values(data.query?.pages ?? {})[0];
  return pagina?.thumbnail?.source ?? null;
}

/** `maxResults` se ignora a propósito: Wikipedia da UNA foto por artículo, no una lista rankeada. */
export const wikipediaImageSearch: ImageSearchFn = async (query) => {
  for (const idioma of IDIOMAS) {
    try {
      const url = await buscarEn(idioma, query, 500);
      if (url) return [{ url, source: `Wikipedia (${idioma})` }];
    } catch {
      // sigue con el próximo idioma
    }
  }
  return [];
};
