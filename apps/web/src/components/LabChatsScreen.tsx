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
 *   · las cards de los chats, deslizables a la izquierda para eliminar,
 *     ahora con título + una línea de "por dónde va".
 *
 * Los datos (crear/borrar/cambiar) viven en laboratorio/page.tsx — este
 * componente es sordo a la persistencia y al motor de turnos, solo pinta
 * `chats` y dispara los callbacks. Así puede probarse solo con datos de
 * mentira si hace falta, y page.tsx no tiene que saber nada de gestos.
 */

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { OrbeIA } from "@/components/orbe/OrbeIA";

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
 * "hace 5 min", "hace 3 h", "ayer", "hace 4 d"… — la línea que Samu quería
 * leer de un vistazo. Es DISTINTA de la fecha: una hora suelta ("23:41") no
 * dice si fue hoy o el mes pasado, y una fecha ("28 ago") obliga a restar
 * mentalmente. Se muestran las dos (ver `formatDate`), esta primero porque es
 * la que casi siempre responde la pregunta.
 *
 * Sin librería: son seis casos y `Intl.RelativeTimeFormat` en español produce
 * "hace 1 días" en algunos tramos si no se le redondea antes igual.
 */
function formatWhen(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return "ahora";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} mes${months === 1 ? "" : "es"}`;
  return `hace ${Math.floor(months / 12)} a`;
}

/** La fecha exacta, debajo de la relativa: hoy es la hora ("23:41"), otro día
 *  es día+mes ("28 ago"). Es el dato que ancla, no el que se lee primero. */
function formatDate(ts: number): string {
  const d = new Date(ts);
  const hoy = new Date();
  const mismoDia =
    d.getFullYear() === hoy.getFullYear() &&
    d.getMonth() === hoy.getMonth() &&
    d.getDate() === hoy.getDate();
  if (mismoDia) return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("es", { day: "2-digit", month: "short" });
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
          <div className="lab-chatcard-top">
            {chat.running && (
              <span className="lab-chatcard-dot" aria-label="Corriendo" title="Corriendo" />
            )}
            <span className="lab-chatcard-title">{chat.title}</span>
          </div>
          {chat.running ? (
            // TRABAJANDO: en vez del último texto (que está congelado en lo
            // que se dijo antes de irse, y por tanto miente) va el orbe SIN
            // ojos, chiquito. Es la forma de decir "aquí abajo está pasando
            // algo que todavía no se puede mostrar" sin inventar un texto ni
            // recurrir a barras de esqueleto — Samu quería el mismo lenguaje
            // visual del orbe, no un placeholder genérico. Sin ojos: en la
            // lista no es "Hermes mirando", es solo el pulso de actividad.
            // Al abrir el chat se ve la conversación real, no esto.
            <span className="lab-chatcard-orbe" role="status" aria-label="Trabajando">
              <OrbeIA tam="16px" ojos={false} ariaLabel="" />
            </span>
          ) : chat.preview ? (
            <span className="lab-chatcard-preview">{chat.preview}</span>
          ) : null}
        </div>
        <div className="lab-chatcard-side">
          <span className="lab-chatcard-when">{formatWhen(chat.updatedAt)}</span>
          <span className="lab-chatcard-date">{formatDate(chat.updatedAt)}</span>
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

  return (
    <div className="lab-chats-screen" role="dialog" aria-modal="true" aria-label="Chats del Laboratorio">
      {/* SIN barra propia: el Navbar del Laboratorio queda por encima de esta
          capa (z-index:3 vs 2) y sigue activo, así que la hamburguesa ya
          cierra la lista y el "+" ya crea un chat. Dibujar aquí otra ✕ y otro
          "+" era duplicar los mismos dos controles en las mismas dos
          esquinas. El hueco de la barra lo reserva el padding-top de
          .lab-chats-screen. */}
      <div className="lab-chats-orbe">
        <OrbeIA tam="110px" ojos ariaLabel="Hermes" />
      </div>

      <div className="lab-chats-list">
        {chats.length === 0 ? (
          <p className="lab-chats-empty">Sin chats todavía en este proyecto.</p>
        ) : (
          chats.map((c) => (
            <SwipeableCard
              key={c.id}
              chat={c}
              active={c.id === activeId}
              onOpen={() => onOpen(c.id)}
              onSwipeLeft={() => onDelete(c.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default LabChatsScreen;
