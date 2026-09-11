import { env } from "../env.js";
import { pexafySearch } from "./pexafy.js";
import type { ImageSearchFn, ImageSearchResult } from "./types.js";

export type { ImageSearchResult } from "./types.js";

/**
 * Proveedor intercambiable, mismo patrón que `websearch/index.ts` (y que
 * `EMBEDDINGS_PROVIDER` antes de eso): hoy solo hay uno (Pexafy), pero el
 * punto de esta capa es que sumar Pexels/Unsplash/Pixabay/Openverse como
 * fallback/router o reemplazar Pexafy por una implementación propia open
 * source sea "un archivo nuevo + una línea acá", sin tocar la tool del
 * agente ni el reloj.
 */
const PROVEEDORES: Record<string, ImageSearchFn> = {
  pexafy: pexafySearch,
};

const CONFIGURADO: Record<string, () => boolean> = {
  pexafy: () => Boolean(env.PEXAFY_API_KEY),
};

export const imageSearchConfigured = CONFIGURADO[env.IMAGESEARCH_PROVIDER]?.() ?? false;

export async function imageSearch(query: string, maxResults = 5): Promise<ImageSearchResult[]> {
  const proveedor = PROVEEDORES[env.IMAGESEARCH_PROVIDER];
  if (!proveedor) {
    throw new Error(`Proveedor de búsqueda de imágenes desconocido: "${env.IMAGESEARCH_PROVIDER}"`);
  }
  return proveedor(query, maxResults);
}
