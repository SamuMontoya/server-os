"use client";

import { useEffect } from "react";
import { useSpeakingPhrase } from "@/hooks/useSpeech";

/**
 * Resalta la frase que la voz está diciendo, como el lector propio.
 *
 * Usa la CSS Custom Highlight API: pinta un Range sin insertar nodos, así no
 * pelea con el árbol que produce <Markdown> ni lo re-renderiza. Si el
 * navegador no la trae (Firefox), no se resalta y la lectura sigue igual.
 *
 * El texto hablado NO es idéntico al del DOM — se le quitaron emojis, marcas
 * y URLs — así que ambos lados se normalizan igual antes de buscar, con un
 * mapa de vuelta a (nodo, offset) para reconstruir el Range.
 */

const NAME = "hermes-speaking";

type Pos = { node: Text; offset: number };

// Aplana el contenedor a texto normalizado + el mapa a su posición original.
function flatten(root: HTMLElement): { text: string; map: Pos[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  const map: Pos[] = [];
  let node = walker.nextNode() as Text | null;
  let lastWasSpace = true; // evita espacio inicial

  while (node) {
    const raw = node.data;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (/\s/.test(ch)) {
        // Los espacios se colapsan igual que en toSpeakable().
        if (!lastWasSpace) {
          text += " ";
          map.push({ node, offset: i });
          lastWasSpace = true;
        }
        continue;
      }
      text += ch;
      map.push({ node, offset: i });
      lastWasSpace = false;
    }
    node = walker.nextNode() as Text | null;
  }
  return { text, map };
}

// Caracteres que la voz nunca dice: se saltan en AMBOS lados de la búsqueda.
const MUDO = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{20E3}\u{200D}]/u;

// Misma poda que hace la voz, para que los dos lados comparen lo mismo.
// OJO: no se puede usar .trim() por carácter — se comería TODOS los espacios
// del texto del DOM mientras la frase hablada sí los conserva, y entonces el
// indexOf no encuentra nunca nada.
function strip(s: string): string {
  return s.replace(new RegExp(MUDO, "gu"), "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function SpeechHighlight({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const phrase = useSpeakingPhrase();

  useEffect(() => {
    // `CSS.highlights` no existe en Firefox: se degrada a no resaltar.
    const store = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (!store) return;

    const root = containerRef.current;
    if (!phrase || !root) {
      store.delete(NAME);
      return;
    }

    const { text, map } = flatten(root);
    const needle = strip(phrase);
    if (!needle) {
      store.delete(NAME);
      return;
    }

    // Se normaliza carácter a carácter GUARDANDO el índice original, para
    // poder volver del match a un Range real. `flatten` ya colapsó espacios,
    // así que aquí basta con saltar los mudos y bajar a minúsculas.
    const keep: number[] = [];
    let norm = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (MUDO.test(ch)) continue;
      norm += ch.toLowerCase();
      keep.push(i);
    }

    const at = norm.indexOf(needle);
    if (at < 0) {
      store.delete(NAME);
      return;
    }

    const startFlat = keep[at];
    const endFlat = keep[Math.min(at + needle.length - 1, keep.length - 1)];
    const a = map[startFlat];
    const b = map[endFlat];
    if (!a || !b) {
      store.delete(NAME);
      return;
    }

    try {
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset + 1);
      const HighlightCtor = (window as unknown as { Highlight?: new (r: Range) => unknown })
        .Highlight;
      if (!HighlightCtor) return;
      store.set(NAME, new HighlightCtor(range));
    } catch {
      // Rango inválido (el DOM cambió entre el flatten y el set): se ignora,
      // el siguiente turno lo vuelve a intentar.
      store.delete(NAME);
    }

    return () => {
      store.delete(NAME);
    };
  }, [phrase, containerRef]);

  return null;
}
