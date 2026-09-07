"use client";

/**
 * Pantalla de "chats abiertos" del Laboratorio — se abre con el botón de
 * menú hamburguesa de la barra superior (ver laboratorio/page.tsx).
 *
 * Forma (pedida por Samu, iteración del 2026-08-31):
 *   · barra superior: cerrar a la izquierda, "nuevo chat" (+) en la esquina
 *     superior DERECHA — el sitio donde ya vive el "crear" en cualquier app,
 *     en vez del botón ancho que antes partía la pantalla en dos;
 *   · el orbe grande y centrado debajo, como retrato de la pantalla;
 *   · las filas de los chats, deslizables a la izquierda para eliminar. Ya no
 *     son cards: Samu pidió (2026-09-01) quitar la caja y dejar solo el borde
 *     inferior, con la misma estructura — título, un subtítulo con la primera
 *     frase de lo último hablado, y el tiempo relativo en la línea del título.
 *
 * Los datos (crear/borrar/cambiar) viven en laboratorio/page.tsx — este
 * componente es sordo a la persistencia y al motor de turnos, solo pinta
 * `chats` y dispara los callbacks. Así puede probarse solo con datos de
 * mentira si hace falta, y page.tsx no tiene que saber nada de gestos.
 *
 * Lista larga (pedido de Samu 2026-09-06): la lista ya crecía llenando el
 * contenedor y scrolleando sin comprimir cada fila (`.lab-chats-list` tiene
 * `flex:1; min-height:0; overflow-y:auto` y ninguna fila tiene flex-grow
 * propio — eso ya venía de fábrica). Lo que faltaba: 1) paginar el RENDER
 * cuando hay muchas filas, en vez de montar todas de una (scroll infinito,
 * ver `CHATS_BATCH_SIZE` + IntersectionObserver más abajo), y 2) un buscador
 * por título que solo aparece una vez que la lista de verdad desborda el
 * contenedor y hace falta scrollear para encontrar algo.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { OrbeIA } from "@/components/orbe/OrbeIA";

/** Cuántas filas se pintan por tanda. Con el tope real de chats (40 en
 *  localStorage, 60 en el servidor — ver lab-persist.ts) casi nunca hace
 *  falta una segunda tanda, pero si algún día sube el límite la lista no
 *  monta cientos de filas de una: solo pinta de más cuando el "centinela"
 *  del fondo entra en pantalla (ver scroll infinito, abajo). */
const CHATS_BATCH_SIZE = 24;

export interface LabChatSummary {
  id: string;
  /** Nombre corto del chat (lo genera haiku; si no, el recorte del 1er mensaje). */
  title: string;
  /** Última cosa dicha en el chat, recortada: la segunda línea de la card. */
  preview?: string;
  updatedAt: number;
  /** true = tenía (o tiene) un turno corriendo la última vez que se supo. */
  running: boolean;
}

interface Props {
  chats: LabChatSummary[];
  activeId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

/** Cuánto hay que arrastrar (px) antes de que soltar cuente como gesto,
 *  no como un tap que se movió un poco por error de dedo. */
const SWIPE_COMMIT_PX = 88;

/**
 * "Ahora", "Hace 10 min", "Ayer", "Hace 4 d"… — el único dato de tiempo de la
 * fila. Antes iba acompañado de la fecha exacta ("23:41" / "28 ago") en una
 * segunda línea; Samu pidió quitarla y dejar SOLO el relativo, alineado con el
 * título: una hora suelta no dice si fue hoy o el mes pasado, y una fecha
 * obliga a restar mentalmente, así que la relativa es la que responde la
 * pregunta y la otra solo hacía ruido.
 *
 * Empieza en MAYÚSCULA porque es un rótulo propio (no continúa ninguna frase),
 * igual que el título de al lado.
 *
 * Sin librería: son seis casos y `Intl.RelativeTimeFormat` en español produce
 * "hace 1 días" en algunos tramos si no se le redondea antes igual.
 */
function formatWhen(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return "Ahora";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Ayer";
  if (days < 30) return `Hace ${days} d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Hace ${months} mes${months === 1 ? "" : "es"}`;
  return `Hace ${Math.floor(months / 12)} a`;
}

/** Una card deslizable: izquierda = `onSwipeLeft` (eliminar). Debajo de la
 *  card, siempre presente, va el fondo de acción — el arrastre solo revela
 *  cuánto se ve, nunca se dibuja nada de más por JS. */
function SwipeableCard({
  chat,
  active,
  onOpen,
  onSwipeLeft,
}: {
  chat: LabChatSummary;
  active: boolean;
  onOpen: () => void;
  onSwipeLeft: () => void;
}) {
  const [dragX, setDragX] = useState(0);
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);

  const onPointerDown = (e: PointerEvent) => {
    draggingRef.current = true;
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    // Gesto vertical (scroll de la lista): se suelta el arrastre horizontal,
    // no pelear con el scroll nativo.
    if (!movedRef.current && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
      draggingRef.current = false;
      setDragX(0);
      return;
    }
    if (Math.abs(dx) > 4) movedRef.current = true;
    // Solo interesa el arrastre hacia la izquierda (eliminar): hacia la
    // derecha no hay acción, así que no se deja "estirar" la card de más.
    setDragX(Math.min(0, dx));
  };

  const finish = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (dragX <= -SWIPE_COMMIT_PX) onSwipeLeft();
    setDragX(0);
  };

  const handleClick = () => {
    if (movedRef.current) return; // fue un swipe, no un tap
    onOpen();
  };

  // El fondo de "eliminar" se revela según cuánto se arrastra a la izquierda.
  const leftReveal = Math.max(0, Math.min(1, -dragX / SWIPE_COMMIT_PX));

  return (
    <div className="lab-chatcard-wrap">
      <div className="lab-chatcard-bg lab-chatcard-bg--delete" style={{ opacity: leftReveal }}>
        <span>✕ Eliminar</span>
      </div>
      <div
        className={`lab-chatcard ${active ? "lab-chatcard--active" : ""}`}
        style={{ transform: `translateX(${dragX}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="lab-chatcard-main">
          {/* Título y "Hace 10 min" van en la MISMA fila (no en una columna
              lateral aparte) porque Samu pidió que el tiempo quede alineado
              con el título. Al compartir fila comparten línea base sin
              cuadrar márgenes a ojo: el `margin-left:auto` del CSS lo manda
              al extremo derecho y el título se queda con el resto. */}
          <div className="lab-chatcard-top">
            <span className="lab-chatcard-title">{chat.title}</span>
            <span className="lab-chatcard-when">{formatWhen(chat.updatedAt)}</span>
          </div>
          {/* Segundo renglón: SIEMPRE poblado. El punto verde de "corriendo"
              se quita de arriba (duplicaba la señal) y el orbe sin ojos se
              muda acá, junto al texto — así nunca queda vacío: o es lo
              último que escribió Samu (mientras espera respuesta) o el
              arranque de lo que va escribiendo el modelo, `chat.preview`
              (ver derivePreview en laboratorio/page.tsx, que cae al último
              mensaje del usuario si el asistente aún no contestó). Mientras
              `running` se fuerza el "…" al final para dejar claro que sigue
              en marcha, sin duplicarlo si `chat.preview` ya lo trae. */}
          {chat.running ? (
            <span className="lab-chatcard-preview lab-chatcard-preview--live">
              <OrbeIA tam="14px" ojos={false} ariaLabel="" />
              <span className="lab-chatcard-preview-text">
                {chat.preview
                  ? chat.preview.endsWith("…")
                    ? chat.preview
                    : `${chat.preview}…`
                  : "Pensando…"}
              </span>
            </span>
          ) : chat.preview ? (
            <span className="lab-chatcard-preview">{chat.preview}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function LabChatsScreen({ chats, activeId, onClose, onOpen, onDelete }: Props) {
  // Escape para salir. La ✕ propia de esta pantalla ya no existe (la
  // hamburguesa del Navbar hace de toggle), pero con teclado Escape sigue
  // siendo lo que uno espera de un role="dialog".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CHATS_BATCH_SIZE);
  const [hasOverflow, setHasOverflow] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Buscar por título (pedido de Samu 2026-09-06): recorta la lista completa
  // ANTES de paginar el render, así el scroll infinito de abajo pagina sobre
  // los resultados de la búsqueda, no sobre todos los chats.
  const filteredChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, query]);

  // Al cambiar de búsqueda se vuelve a la primera tanda y al tope de la
  // lista — si no, un filtro nuevo podría heredar el scroll/tanda de la
  // búsqueda anterior y arrancar mostrando de menos (o de más) resultados.
  useEffect(() => {
    setVisibleCount(CHATS_BATCH_SIZE);
    listRef.current?.scrollTo({ top: 0 });
  }, [query]);

  const visibleChats = filteredChats.slice(0, visibleCount);
  const hasMore = visibleCount < filteredChats.length;

  // Scroll infinito: la lista nunca monta más de una tanda de filas de una —
  // cuando el "centinela" invisible del fondo entra en pantalla, se pinta la
  // siguiente. Con el tope real de chats (40-60, ver lab-persist.ts) casi
  // nunca hace falta una segunda tanda, pero si algún día hay muchos más,
  // esto evita meter cientos de nodos al DOM de una sola vez.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((n) => Math.min(filteredChats.length, n + CHATS_BATCH_SIZE));
        }
      },
      { root, rootMargin: "200px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, filteredChats.length]);

  // El buscador SOLO aparece cuando la lista de verdad desborda su
  // contenedor y por lo tanto ya hace falta scrollear para llegar a un chat
  // viejo (pedido de Samu 2026-09-06): con pocos chats, todos caben a la
  // vista y un input de búsqueda sería puro ruido antes de esa raya de agua.
  //
  // OJO (pedido de Samu 2026-09-06, segunda ronda): el chequeo se congela
  // mientras `query` tiene texto. Antes dependía de `visibleChats.length`,
  // que es la lista YA FILTRADA — en cuanto escribías algo que recortaba los
  // resultados por debajo del alto del contenedor, `hasOverflow` pasaba a
  // false y el propio input de búsqueda se desmontaba solo mientras el
  // usuario seguía escribiendo en él. La pregunta "¿hace falta buscador?"
  // solo tiene sentido sobre la lista COMPLETA (sin filtrar): si ya se
  // decidió que sí hace falta, debe seguir ahí durante toda la búsqueda,
  // sin importar cuántos resultados vayan quedando.
  useEffect(() => {
    if (query.trim()) return;
    const el = listRef.current;
    if (!el) return;
    const check = () => setHasOverflow(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visibleChats.length, chats.length, query]);

  return (
    <div className="lab-chats-screen" role="dialog" aria-modal="true" aria-label="Chats">
      {/* SIN barra propia: el Navbar del Laboratorio queda por encima de esta
          capa (z-index:3 vs 2) y sigue activo, así que la hamburguesa ya
          cierra la lista y el "+" ya crea un chat. Dibujar aquí otra ✕ y otro
          "+" era duplicar los mismos dos controles en las mismas dos
          esquinas. El hueco de la barra lo reserva el padding-top de
          .lab-chats-screen. */}
      {chats.length === 0 ? (
        <div className="lab-chats-empty">
          <OrbeIA tam="132px" ojos ariaLabel="OS" />
          <p className="lab-chats-empty-title">Aún no hay chats aquí</p>
          <p className="lab-chats-empty-hint">
            Toca el <strong>+</strong> de arriba para empezar uno nuevo.
          </p>
        </div>
      ) : (
        <>
          <div className="lab-chats-orbe">
            <OrbeIA tam="132px" ojos ariaLabel="OS" />
          </div>
          {hasOverflow && (
            <div className="lab-chats-search">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar chat por título…"
                aria-label="Buscar chat por título"
              />
            </div>
          )}
          <div className="lab-chats-list" ref={listRef}>
            {visibleChats.map((c) => (
              <SwipeableCard
                key={c.id}
                chat={c}
                active={c.id === activeId}
                onOpen={() => onOpen(c.id)}
                onSwipeLeft={() => onDelete(c.id)}
              />
            ))}
            {hasMore && <div ref={sentinelRef} className="lab-chats-sentinel" aria-hidden="true" />}
            {query.trim() && filteredChats.length === 0 && (
              <p className="lab-chats-empty-hint" style={{ padding: "16px 6px" }}>
                Sin resultados para “{query.trim()}”.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default LabChatsScreen;
