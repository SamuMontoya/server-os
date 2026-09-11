import { imageSearch, imageSearchConfigured } from "../imagesearch/index.js";
import { wikipediaImageSearch } from "../imagesearch/wikipedia.js";

/**
 * Primera imagen de internet para una consulta ("muéstrame un husky").
 *
 * Antes esto era Wikipedia (portada del artículo) + Openverse de respaldo,
 * sin API key. Reemplazado por Pexafy: un solo proveedor que ya busca +
 * rankea + pagina sobre 9 bancos de fotos libres (Unsplash, Pexels, Pixabay
 * y más), con búsqueda por SIGNIFICADO en vez de coincidencia de palabras —
 * mismo motivo que Tavily para texto: una sola llamada bien hecha en vez de
 * armar el pipeline a mano contra varias fuentes gratis pero limitadas.
 *
 * `indice` 0 es la primera imagen; 1, 2… son "esa no, otra". Pexafy pagina
 * de verdad (a diferencia de la vieja portada única de Wikipedia), así que
 * no hace falta la división en dos fuentes de antes — se pide `indice + 1`
 * resultados y se toma el último; para "otra" varias veces seguidas esto
 * repite trabajo (vuelve a traer las anteriores), pero es la única forma
 * simple sin cursores para un caso que en la práctica no pasa de 2-3 toques.
 *
 * Se pide la MINIATURA, no `url` (mediana/grande): en una pantalla de ~200pt
 * no se nota la diferencia de resolución, pero sí el peso. Es literalmente lo
 * que pedía el spec original ("mostrar thumbnails... en milisegundos"), que
 * se había perdido al armar el mapeo de `pexafy.ts` pensando en un
 * consumidor de pantalla grande.
 *
 * Y se descarga ACÁ, en el servidor, no en el reloj: antes se mandaba la URL
 * al reloj y era ÉL quien la bajaba, una SEGUNDA conexión saliente además de
 * la del `/watch/ask` — exactamente lo que WatchKit pide evitar (WWDC19/716,
 * ya citado en `Agente.swift`: "reducir el número de peticiones al mínimo
 * absoluto"), porque cada una paga el túnel Bluetooth al iPhone desde cero.
 * Con la foto embebida en base64 dentro del mismo evento SSE que ya está
 * abierto, el reloj no abre nada nuevo: la pinta apenas la recibe, sin una
 * segunda pantalla de carga genérica esperando esa descarga aparte.
 */
/**
 * `persona`: viene del clasificador (ver `IMAGEN-PERSONA:` en `rapido.ts`) —
 * pide alguien real identificable por nombre, así que se busca en Wikipedia
 * en vez de en Pexafy. Con fallback a Pexafy si Wikipedia no tiene artículo
 * o el artículo no trae foto (alguien menos conocido): es mejor traer ALGO
 * relacionado que nada, la misma filosofía que el resto de este archivo.
 *
 * Ese fallback SOLO aplica en `indice === 0`: Wikipedia da UNA foto por
 * artículo, sin paginar, así que "otra" sobre una persona no tiene una
 * segunda foto que ofrecer desde ahí — y encadenar a Pexafy en ese caso
 * volvería a traer "algo relacionado, no la persona", justo la queja
 * original. Más honesto decir que no hay más que fingir una segunda.
 */
export async function buscarImagen(
  q: string,
  indice = 0,
  persona = false,
): Promise<{ datos: string; mime: string } | null> {
  const consulta = q.trim();
  if (!consulta) return null;

  try {
    let url: string | undefined;
    if (persona) {
      if (indice === 0) {
        url = (await wikipediaImageSearch(consulta, 1))[0]?.url;
        if (!url && imageSearchConfigured) {
          const hit = (await imageSearch(consulta, 1))[0];
          url = hit?.thumbnailUrl ?? hit?.url;
        }
      }
    } else if (imageSearchConfigured) {
      const hits = await imageSearch(consulta, indice + 1);
      const hit = hits[indice];
      url = hit?.thumbnailUrl ?? hit?.url;
    }
    if (!url) return null;

    const r = await fetch(url);
    if (!r.ok) return null;
    const mime = r.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const datos = Buffer.from(await r.arrayBuffer()).toString("base64");
    return { datos, mime };
  } catch {
    return null;
  }
}
