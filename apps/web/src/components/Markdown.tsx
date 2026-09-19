"use client";

import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useDocViewer } from "./DocViewer";

/**
 * Renderizador de markdown mínimo y SIN dependencias. Construye nodos React
 * (no HTML crudo) → seguro por construcción, sin riesgo de inyección. Cubre lo
 * típico de un reporte: títulos, listas (ordenadas/no), código en bloque e
 * inline, citas, separadores, énfasis y enlaces. No pretende cubrir todo el
 * spec de CommonMark; sí lo que Hermes produce como salida hablada→escrita.
 *
 * Las referencias a documentos del vault — wikilinks `[[nombre]]` y enlaces a
 * `*.md` — se vuelven clickables y abren el visor tipo Notion (ver DocViewer).
 */

// Proyecto en foco del <Markdown> actual: desambigua wikilinks repetidos al
// resolverlos en el server. Lo lee <DocRef> sin tener que pasar props abajo.
const MdProjectCtx = createContext<string | undefined>(undefined);

// ¿La URL de un [texto](url) apunta a un .md del vault (no a http/mailto)?
function isDocLink(href: string): boolean {
  return /\.md(#|\?|$)/i.test(href) && !/^[a-z]+:\/\//i.test(href) && !href.startsWith("mailto:");
}

// Referencia clickable a un doc del vault. Cae a texto plano si no hay visor.
function DocRef({ refName, label }: { refName: string; label: string }) {
  const open = useDocViewer();
  const project = useContext(MdProjectCtx);
  return (
    <button
      type="button"
      className="md-ref"
      onClick={() => open(refName, project)}
      title={`Abrir ${label}`}
    >
      {label}
    </button>
  );
}

// Bloque de código ```: un clic lo copia entero al portapapeles. Pensado
// sobre todo para el caso típico de Hermes — un comando único de una línea
// en su propia valla — pero se aplica igual a cualquier bloque, largo o
// corto: es la convención esperada (GitHub, VS Code, etc.) y no hay motivo
// para que un bloque de varias líneas no la tenga también.
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <pre
      className={`md-pre${copied ? " md-pre-copied" : ""}`}
      role="button"
      tabIndex={0}
      title={copied ? "Copiado" : "Clic para copiar"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), 1200);
        } catch {
          // Sin permiso de portapapeles: no hay mucho más que hacer acá.
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (e.currentTarget as HTMLElement).click();
        }
      }}
    >
      <code>{code}</code>
    </pre>
  );
}

function renderInline(text: string, kp: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[\[[^\]]+\]\])|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${kp}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={key} className="md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[[")) {
      // Wikilink: "[[nombre|alias]]" → ref=nombre, muestra el alias si lo hay.
      const inner = tok.slice(2, -2);
      const [name, alias] = inner.split("|");
      nodes.push(<DocRef key={key} refName={name.trim()} label={(alias ?? name).trim()} />);
    } else if (tok.startsWith("[")) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (mm && isDocLink(mm[2])) {
        nodes.push(<DocRef key={key} refName={mm[2]} label={mm[1]} />);
      } else {
        nodes.push(
          mm ? (
            <a key={key} href={mm[2]} target="_blank" rel="noreferrer" className="md-link">
              {mm[1]}
            </a>
          ) : (
            tok
          ),
        );
      }
    } else {
      nodes.push(<em key={key}>{tok.replace(/^[*_]|[*_]$/g, "")}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const SPECIAL = /^(#{1,6})\s|^```|^>\s?|^\s*[-*+]\s+|^\s*\d+\.\s+|^(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Junta las líneas de UNA lista (ordenada o no), sin cortarla prematuramente
 * ante dos patrones típicos de lo que escribe un LLM (bug real, reporte de
 * Jaime 2026-09-19: "a veces no numera bien y las pone todas como si fueran
 * una"):
 *
 *  1. Listas "sueltas" (línea en blanco entre ítems: "1. A\n\n2. B"). Sin
 *     este manejo, la línea en blanco cortaba la lista, el ítem 2 abría un
 *     `<ol>` NUEVO (reinicia en 1) y el navegador mostraba "1." repetido en
 *     vez de "1., 2., 3." — cada fragmento parecía "todo el mismo ítem".
 *  2. Continuación de un ítem en la línea siguiente sin volver a numerar
 *     ("1. Texto\n   más detalle\n2. Otro"): esa línea de continuación
 *     tampoco matcheaba el marcador y cortaba la lista igual que el caso 1.
 *
 * Se hace `peek` hacia adelante saltando líneas en blanco: si más adelante
 * sigue habiendo un ítem del MISMO tipo de lista, las líneas de por medio se
 * absorben (blancas se descartan, de texto se anexan al último ítem) en vez
 * de cerrar la lista. Solo se corta de verdad cuando lo que sigue ya no es
 * ni un ítem ni algo que pueda pertenecerle (otro bloque SPECIAL, o el fin
 * del texto).
 *
 * Trade-off ACEPTADO (auditoría adversaria 2026-09-19): dos listas del mismo
 * tipo separadas por NADA MÁS que una línea en blanco ("1. A\n2. B\n\n1. C\n2. D",
 * sin texto/encabezado de por medio) se fusionan en una sola lista continua
 * (1,2,3,4) en vez de quedar como dos — mismo comportamiento que CommonMark/
 * GitHub en el caso análogo (una lista "suelta" y dos listas consecutivas son
 * indistinguibles sin algo que las separe). Es intencional, no un bug: la
 * alternativa (cortar ante CUALQUIER línea en blanco seguida de un ítem que
 * reinicia en "1.") reintroduciría exactamente el bug original que este
 * fix arregla, porque el LLM genera esa misma forma ("1. Uno\n\n2. Dos\n\n3.
 * Tres") como una única lista suelta legítima la mayoría de las veces. Si el
 * modelo necesita dos listas realmente separadas, un párrafo/encabezado de
 * por medio (lo normal en su propia salida) ya las separa bien — ver el test
 * (jaime-os, este repo no tiene vitest) "dos listas de verdad separadas por
 * un párrafo NO se fusionan".
 */
function collectListItems(
  lines: string[],
  start: number,
  markerRe: RegExp,
): { items: string[]; nextIndex: number } {
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    if (markerRe.test(lines[i])) {
      items.push(lines[i].replace(markerRe, ""));
      i++;
      continue;
    }
    if (/^\s*$/.test(lines[i])) {
      let j = i;
      while (j < lines.length && /^\s*$/.test(lines[j])) j++;
      if (j < lines.length && markerRe.test(lines[j])) {
        i = j; // línea(s) en blanco DENTRO de la lista: se saltan, no la cierran.
        continue;
      }
      break; // línea en blanco seguida de algo que no es un ítem: fin real.
    }
    // Continuación de texto del ítem anterior (ni ítem, ni blanco, ni otro
    // bloque especial ni el arranque de una tabla): se anexa, no corta.
    if (items.length > 0 && !SPECIAL.test(lines[i]) && !isTableStart(lines, i)) {
      items[items.length - 1] += ` ${lines[i].trim()}`;
      i++;
      continue;
    }
    break;
  }
  return { items, nextIndex: i };
}

// ── Tablas (GFM) ──────────────────────────────────────────────────────
// Lo que hace tabla a una tabla es la fila de guiones DEBAJO del encabezado.
// Sin ella son pipes sueltos y se tratan como párrafo — por eso la detección
// mira siempre la línea siguiente, no la actual.
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableStart(lines: string[], i: number): boolean {
  return (
    lines[i].includes("|") &&
    i + 1 < lines.length &&
    TABLE_SEP.test(lines[i + 1]) &&
    lines[i + 1].includes("-")
  );
}

function splitRow(line: string): string[] {
  let s = line.trim();
  // Los pipes de los bordes son opcionales en GFM.
  if (s.startsWith("|")) s = s.slice(1);
  if (/(?<!\\)\|$/.test(s)) s = s.slice(0, -1);
  // Un `\|` escapado es contenido de la celda, no un corte.
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function alignOf(cell: string): "left" | "center" | "right" | undefined {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return undefined;
}

export function Markdown({ source, project }: { source: string; project?: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Bloque de código ```
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // cierra la valla
      blocks.push(<CodeBlock key={key++} code={buf.join("\n")} />);
      continue;
    }

    // Título
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(h[1].length, 4);
      const Tag = `h${lvl}` as "h1" | "h2" | "h3" | "h4";
      // Ojo: el key de JSX se evalúa DESPUÉS de los children — key++ inline
      // dentro de los children desfasaba el key del elemento y chocaba con el
      // del bloque siguiente. Se fija ANTES en una const.
      const k = key++;
      blocks.push(
        <Tag key={k} className={`md-h md-h${lvl}`}>
          {renderInline(h[2], `h${k}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Separador
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // Cita
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      const k = key++;
      blocks.push(
        <blockquote key={k} className="md-quote">
          {renderInline(buf.join(" "), `q${k}`)}
        </blockquote>,
      );
      continue;
    }

    // Lista no ordenada
    if (/^\s*[-*+]\s+/.test(line)) {
      const { items: raw, nextIndex } = collectListItems(lines, i, /^\s*[-*+]\s+/);
      i = nextIndex;
      const k = key++;
      blocks.push(
        <ul key={k} className="md-ul">
          {raw.map((text, n) => (
            <li key={n} className="md-li">
              {renderInline(text, `li${k}-${n}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Lista ordenada
    if (/^\s*\d+\.\s+/.test(line)) {
      // Guarda el número real del primer ítem: si el modelo arranca en "3."
      // (continuación de una lista que el propio parser fragmentó en otro
      // `source`, ver el bloque de streaming en vivo), el `<ol>` respeta ese
      // arranque en vez de reiniciar en 1 — no es EL fix de fondo (que es no
      // cortar la lista, ver `collectListItems`), pero cubre el caso en que
      // sí toca fragmentar de verdad (dos `<Markdown>` separados).
      const firstNum = Number((/^\s*(\d+)\./.exec(line) ?? [, "1"])[1]);
      const { items: raw, nextIndex } = collectListItems(lines, i, /^\s*\d+\.\s+/);
      i = nextIndex;
      const k = key++;
      blocks.push(
        <ol key={k} className="md-ol" start={firstNum !== 1 ? firstNum : undefined}>
          {raw.map((text, n) => (
            <li key={n} className="md-li">
              {renderInline(text, `ol${k}-${n}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Tabla
    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i++]));
      }
      const k = key++;
      blocks.push(
        // El wrapper scrollea aparte: una tabla ancha no debe empujar el hilo
        // ni forzar scroll horizontal en toda la página.
        <div key={k} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n} style={{ textAlign: aligns[n] }}>
                    {renderInline(c, `th${k}-${n}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {/* Se recorre el ENCABEZADO, no la fila: una fila con menos
                      celdas de las debidas dejaría la tabla desalineada. */}
                  {head.map((_, n) => (
                    <td key={n} style={{ textAlign: aligns[n] }}>
                      {renderInline(r[n] ?? "", `td${k}-${ri}-${n}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Línea en blanco
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Párrafo (junta líneas consecutivas no especiales)
    const buf: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !SPECIAL.test(lines[i]) &&
      // Una tabla pegada al párrafo (sin línea en blanco) no se traga aquí.
      !isTableStart(lines, i)
    ) {
      buf.push(lines[i++]);
    }
    const k = key++;
    blocks.push(
      <p key={k} className="md-p">
        {/* Se unen con \n (no con espacio) para que el salto simple sobreviva:
            .md-p usa white-space:pre-line y lo pinta como salto real. */}
        {renderInline(buf.join("\n"), `p${k}`)}
      </p>,
    );
  }

  return (
    <MdProjectCtx.Provider value={project}>
      <div className="md">{blocks}</div>
    </MdProjectCtx.Provider>
  );
}

/**
 * Markdown fuente → HTML real (h1-h4, strong, em, code, table, ul/ol, etc),
 * para el botón de copiar (Jaime pidió 2026-09-15: pegar en Notion y que
 * quede formateado — encabezados, negritas y TABLAS reales, no texto plano
 * ni el markdown crudo con `#`/`|` a la vista).
 *
 * Reusa el MISMO parser que pinta en pantalla (`<Markdown>`) en vez de
 * escribir un segundo conversor de markdown en paralelo: lo que se ve en el
 * chat es exactamente lo que se copia, sin una segunda implementación que
 * mantener sincronizada ni sus propios bugs de parseo.
 *
 * `renderToStaticMarkup` no ejecuta efectos ni pinta interactividad (no hace
 * falta: es una foto fija para el portapapeles) — los `useState`/`useContext`
 * de adentro (CodeBlock, DocRef) corren igual con su valor inicial, sin
 * romper nada. `DocRef` sale como un <button> de texto plano: un wikilink no
 * es un link real fuera del chat, así que perder el click en Notion no
 * pierde nada que sí funcionara ahí.
 */
export function markdownToHtml(source: string, project?: string): string {
  return renderToStaticMarkup(<Markdown source={source} project={project} />);
}
