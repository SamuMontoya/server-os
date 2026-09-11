import { env } from "../env.js";
import { tavilySearch } from "./tavily.js";
import type { WebSearchFn, WebSearchOpts, WebSearchResult } from "./types.js";

export type { WebSearchResult, WebSearchOpts } from "./types.js";

/**
 * Proveedor intercambiable, mismo patrón que `EMBEDDINGS_PROVIDER`: hoy solo
 * hay uno (Tavily), pero el punto de esta capa es que sumar un fallback/
 * router (Exa, Brave, SearXNG) o reemplazar Tavily por una implementación
 * propia open source sea "un archivo nuevo + una línea acá", sin tocar la
 * tool del agente ni su prompt.
 *
 * NO hay un modo "respuesta ya sintetizada por el proveedor" a propósito:
 * se probó con `include_answer` de Tavily (ver git blame) y en vivo
 * inventaba datos distintos para el MISMO hecho en llamadas casi idénticas
 * cuando sus resultados eran ambiguos — la síntesis la hace siempre el LLM
 * que llama, que sí se le puede pedir explícitamente que no adivine.
 */
const PROVEEDORES: Record<string, WebSearchFn> = {
  tavily: tavilySearch,
};

const CONFIGURADO: Record<string, () => boolean> = {
  tavily: () => Boolean(env.TAVILY_API_KEY),
};

export const webSearchConfigured = CONFIGURADO[env.WEBSEARCH_PROVIDER]?.() ?? false;

export async function webSearch(
  query: string,
  maxResults = 5,
  opts?: WebSearchOpts,
): Promise<WebSearchResult[]> {
  const proveedor = PROVEEDORES[env.WEBSEARCH_PROVIDER];
  if (!proveedor) {
    throw new Error(`Proveedor de búsqueda web desconocido: "${env.WEBSEARCH_PROVIDER}"`);
  }
  return proveedor(query, maxResults, opts);
}
