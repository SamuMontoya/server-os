/**
 * Forma común de un resultado de búsqueda de imágenes, sin importar el
 * proveedor. Mismo patrón que `websearch/types.ts`: cualquier proveedor
 * nuevo (Pexels, Unsplash, Pixabay, Openverse, uno propio) implementa
 * `search()` con esta firma — la tool del agente y el reloj no saben ni
 * les importa cuál está detrás.
 */
export interface ImageSearchResult {
  /** URL lista para mostrar (tamaño mediano/grande, no la miniatura). */
  url: string;
  /** Miniatura, si el proveedor la da por separado — para listas/previews. */
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  photographer?: string;
  photographerUrl?: string;
  /** De qué banco de imágenes salió (Pexels, Unsplash, Pixabay...). */
  source?: string;
  /** Texto de crédito listo para mostrar, si el proveedor lo exige/sugiere. */
  attribution?: string;
}

export type ImageSearchFn = (query: string, maxResults: number) => Promise<ImageSearchResult[]>;
