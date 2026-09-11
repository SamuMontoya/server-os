import { env } from "../env.js";
import type { ImageSearchFn } from "./types.js";

const BASE = "https://api.pexafy.com/api/v1/search/photos";

/**
 * Pexafy indexa 9 bancos de imágenes libres (Unsplash, Pexels, Pixabay y
 * otros) en un solo catálogo y busca por SIGNIFICADO, no por palabras clave
 * sueltas — una frase descriptiva completa da mejores resultados que dos
 * términos ("un husky siberiano corriendo en la nieve" > "husky nieve").
 * Búsqueda + ranking + miniaturas + metadata en UNA sola llamada, sin
 * scraping propio — mismo pipeline que Tavily para texto.
 *
 * `sort_by: "relevance"` (default del proveedor, explícito acá para no
 * depender de que no cambie) — no hace falta `score_threshold`: preferible
 * traer algo aproximado que nada, el llamador decide si le sirve.
 */
export const pexafySearch: ImageSearchFn = async (query, maxResults) => {
  if (!env.PEXAFY_API_KEY) throw new Error("PEXAFY_API_KEY no configurada");

  const params = new URLSearchParams({
    q: query,
    per_page: String(Math.min(Math.max(maxResults, 1), 100)),
    sort_by: "relevance",
  });

  const r = await fetch(`${BASE}?${params.toString()}`, {
    headers: { "x-api-key": env.PEXAFY_API_KEY },
  });

  if (!r.ok) {
    const cuerpo = await r.text().catch(() => "");
    throw new Error(`Pexafy respondió ${r.status}: ${cuerpo.slice(0, 200)}`);
  }

  const data = (await r.json()) as {
    data?: {
      urls?: { thumb?: string; small?: string; regular?: string; large?: string; full?: string };
      width?: number;
      height?: number;
      photographer_full_name?: string;
      photographer_url?: string;
      source?: string;
      attribution?: { plain?: string };
    }[];
  };

  return (data.data ?? [])
    .map((x) => ({
      url: x.urls?.regular ?? x.urls?.large ?? x.urls?.full ?? x.urls?.small ?? "",
      thumbnailUrl: x.urls?.thumb ?? x.urls?.small,
      width: x.width,
      height: x.height,
      photographer: x.photographer_full_name,
      photographerUrl: x.photographer_url,
      source: x.source,
      attribution: x.attribution?.plain,
    }))
    .filter((x) => x.url);
};
