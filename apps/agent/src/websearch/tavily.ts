import { env } from "../env.js";
import type { WebSearchFn } from "./types.js";

const BASE = "https://api.tavily.com/search";

/**
 * Tavily ya hace búsqueda + ranking + extracción del contenido relevante de
 * cada página en UNA sola llamada — exactamente el pipeline
 * "búsqueda → ranking → contenido relevante" que se quería exponer al
 * agente, sin tener que armarlo a mano con un buscador + scraper propios.
 *
 * `search_depth: "fast"` — NO "ultra-fast": medido en vivo con un hecho
 * recién ocurrido (ganador de un mundial recién jugado), "ultra-fast" daba
 * una respuesta distinta e incorrecta en llamadas casi idénticas ("aún no
 * se ha jugado", "aún no ha sido definido", mezclando datos de una edición
 * VIEJA) — su rastreo es tan superficial que para un hecho reciente puede
 * traer sobre todo páginas PRE-evento, que siguen siendo mayoría en el
 * índice. "fast" dio la respuesta correcta en 3/3 intentos, al mismo tiempo
 * (0.74s la primera vez, 0.0s las siguientes — Tavily cachea la consulta
 * exacta). Sin `include_answer`/`include_raw_content`: el resumen ya lo
 * hace el LLM que recibe esto, pedirle a Tavily que también sintetice solo
 * suma tokens y latencia por algo que se descarta.
 */
export const tavilySearch: WebSearchFn = async (query, maxResults, opts) => {
  if (!env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY no configurada");

  const r = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "fast",
      max_results: Math.min(Math.max(maxResults, 1), 10),
      // `opts.news` cambia DOS cosas juntas, no solo el índice:
      //
      // - `topic: "news"` trae prensa real y fechada en vez del índice
      //   general (dominado por SEO/apuestas para temas competidos — "mundial
      //   2026 ganador" en general daba solo páginas de apuestas; en news dio
      //   AP News/Reuters reales). PERO probado en vivo: rompe precios y
      //   clima — "precio bitcoin" en modo news trae NOTICIAS sobre bitcoin
      //   (un hackeo, una empresa acumulando), no una cifra. Esas páginas
      //   (cotizadores, pronósticos) son "general", no prensa, así que
      //   `opts.news` es una decisión del LLAMADOR: solo para preguntas de
      //   hechos/personas/resultados, nunca para precios/clima.
      // - `time_range`: "year" (el default de siempre) es DEMASIADO ancho
      //   para noticias — dejaba pasar una página de hace meses con tal de
      //   que mencionara el tema. Con `news`, "week" da resultados mucho más
      //   ajustados a lo actual (confirmado en vivo: encontró la nota de
      //   Reuters correcta recién con time_range semanal, no anual). Para
      //   precios/clima (`news` false) se deja "year": esas páginas son
      //   plantillas que se regeneran solas, filtrarlas por fecha de
      //   publicación no tiene el mismo sentido.
      time_range: opts?.news ? "week" : "year",
      topic: opts?.news ? "news" : "general",
    }),
  });

  if (!r.ok) {
    const cuerpo = await r.text().catch(() => "");
    throw new Error(`Tavily respondió ${r.status}: ${cuerpo.slice(0, 200)}`);
  }

  const data = (await r.json()) as {
    results?: { title: string; url: string; content: string; score: number }[];
  };
  return (data.results ?? []).map((x) => ({
    title: x.title,
    url: x.url,
    content: x.content,
    score: x.score,
  }));
};
