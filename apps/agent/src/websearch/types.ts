/**
 * Forma común de un resultado de búsqueda web, sin importar el proveedor.
 * Cualquier proveedor nuevo (Exa, Brave, SearXNG, uno propio) implementa
 * `search()` con esta firma — es lo que hace que la tool `web_search` y el
 * prompt del agente no sepan ni les importe cuál está detrás.
 */
export interface WebSearchResult {
  title: string;
  url: string;
  /** Extracto de contenido YA relevante para la consulta, no HTML crudo. */
  content: string;
  /** Score de relevancia del proveedor, si lo da (0–1 en Tavily). */
  score?: number;
}

export interface WebSearchOpts {
  /**
   * Sesga hacia noticias reales y fechadas en vez del índice general (SEO,
   * apuestas, trivia) — para preguntas explícitamente sobre algo actual
   * (resultados, cargos, eventos recientes). No todos los proveedores lo
   * implementan; los que no, lo ignoran sin romperse.
   */
  news?: boolean;
}

export type WebSearchFn = (
  query: string,
  maxResults: number,
  opts?: WebSearchOpts,
) => Promise<WebSearchResult[]>;
