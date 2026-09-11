/**
 * Trocea texto largo en fragmentos embebibles.
 *
 * nomic-embed-text (Ollama) tiene ventana de 8192 tokens; ~6000 caracteres es
 * un margen cómodo (≈1500-1700 tokens en español) sin acercarse al límite.
 * El solape evita que una idea que cruza el corte quede partida sin contexto
 * en NINGUNO de los dos fragmentos.
 */
export const CHUNK_SIZE_CHARS = 6_000;
export const CHUNK_OVERLAP_CHARS = 300;

export function chunkText(
  text: string,
  chunkSize = CHUNK_SIZE_CHARS,
  overlap = CHUNK_OVERLAP_CHARS,
): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + chunkSize, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = end - overlap;
  }
  return chunks;
}
