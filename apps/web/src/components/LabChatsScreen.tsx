"use client";

/**
 * Pantalla de "chats abiertos" del Laboratorio — se abre con el botón de
 * menú hamburguesa de la barra superior (ver laboratorio/page.tsx).
 *
 * Samu pidió: el orbe arriba (la misma mascota de todo Hermes), debajo las
 * cards de los chats del proyecto en foco, deslizables — izquierda para
 * eliminar, derecha para archivar —, un botón para crear uno nuevo, y abajo
 * del todo una sección "Archivados".
 *
 * Los datos (crear/archivar/borrar/cambiar) viven en laboratorio/page.tsx —
 * este componente es sordo a la persistencia y al motor de turnos, solo
 * pinta `chats` y dispara los callbacks. Así puede probarse solo con datos
 * de mentira si hace falta, y page.tsx no tiene que saber nada de gestos.
 */

import { useRef, useState, type PointerEvent } from "react";
import { OrbeIA } from "@/components/orbe/OrbeIA";

export interface LabChatSummary {
  id: string;
  /** Primeras palabras del primer mensaje, o "Chat nuevo" si está vacío. */
  title: string;
  updatedAt: number;
  archived: boolean;
  /** true = tenía (o tiene) un turno corriendo la última vez que se supo. */
  running: boolean;
}

interface Props {
  chats: LabChatSummary[];
  activeId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Cuánto hay que arrastrar (px) antes de que soltar cuente como gesto,
 *  no como un tap que se movió un poco por error de dedo. */
const SWIPE_COMMIT_PX = 88;

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const hoy = new Date();
  const mismoDia =
    d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth() && d.getDate() === hoy.getDate();
  if (mismoDia) return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("es", { day: "2-digit", month: "short" });
}

/** Una card deslizable. Izquierda = `onSwipeLeft` (eliminar), derecha =
 *  `onSwipeRight` (archivar/desarchivar). Debajo de la card, siempre
 *  presentes, van los dos fondos de acción — el arrastre solo revela cuál
 *  se ve, nunca se dibuja nada de más por JS. */
function SwipeableCard({
  chat,
  active,
  onOpen,
  onSwipeLeft,
  onSwipeRight,
  rightLabel,
  rightGlyph,
}: {
  chat: LabChatSummary;
  active: boolean;
  onOpen: () => void;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  rightLabel: string;
  rightGlyph: string;
}) {
  const [dragX, setDragX] = useState(0);
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);

  const onPointerDown = (e: PointerEvent) => {
    // Los botones de acción (si alguna vez se agregan) no deben arrastrar la
    // card entera; por ahora la card completa es el asa.
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
    setDragX(dx);
  };

  const finish = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (dragX <= -SWIPE_COMMIT_PX) onSwipeLeft();
    else if (dragX >= SWIPE_COMMIT_PX) onSwipeRight();
    setDragX(0);
  };

  const handleClick = () => {
    if (movedRef.current) return; // fue un swipe, no un tap
    onOpen();
  };

  // El fondo que se revela depende de hacia dónde se arrastra; el otro
  // permanece invisible detrás de la card (opacity por proximidad al umbral).
  const leftReveal = Math.max(0, Math.min(1, -dragX / SWIPE_COMMIT_PX));
  const rightReveal = Math.max(0, Math.min(1, dragX / SWIPE_COMMIT_PX));

  return (
    <div className="lab-chatcard-wrap">
      <div className="lab-chatcard-bg lab-chatcard-bg--delete" style={{ opacity: leftReveal }}>
        <span>✕ Eliminar</span>
      </div>
      <div className="lab-chatcard-bg lab-chatcard-bg--archive" style={{ opacity: rightReveal }}>
        <span>{rightGlyph} {rightLabel}</span>
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
          <span className="lab-chatcard-title">{chat.title}</span>
          <span className="lab-chatcard-when">{formatWhen(chat.updatedAt)}</span>
        </div>
        {chat.running && (
          <span className="lab-chatcard-dot" aria-label="Corriendo" title="Corriendo" />
        )}
      </div>
    </div>
  );
}

export function LabChatsScreen({
  chats,
  activeId,
  onClose,
  onOpen,
  onNew,
  onArchive,
  onUnarchive,
  onDelete,
}: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const activos = chats.filter((c) => !c.archived);
  const archivados = chats.filter((c) => c.archived);

  return (
    <div className="lab-chats-screen" role="dialog" aria-modal="true" aria-label="Chats del Laboratorio">
      <div className="lab-chats-head">
        <button type="button" className="lab-chats-close" onClick={onClose} aria-label="Cerrar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="lab-chats-orbe">
        <OrbeIA tam="72px" ojos ariaLabel="Hermes" />
      </div>

      <button type="button" className="lab-chats-new" onClick={onNew}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Nuevo chat
      </button>

      <div className="lab-chats-list">
        {activos.length === 0 ? (
          <p className="lab-chats-empty">Sin chats todavía en este proyecto.</p>
        ) : (
          activos.map((c) => (
            <SwipeableCard
              key={c.id}
              chat={c}
              active={c.id === activeId}
              onOpen={() => onOpen(c.id)}
              onSwipeLeft={() => onDelete(c.id)}
              onSwipeRight={() => onArchive(c.id)}
              rightLabel="Archivar"
              rightGlyph="⤓"
            />
          ))
        )}

        <button
          type="button"
          className="lab-chats-archived-toggle"
          onClick={() => setArchivedOpen((o) => !o)}
          aria-expanded={archivedOpen}
        >
          Archivados {archivados.length > 0 ? `(${archivados.length})` : ""}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            style={{ transform: archivedOpen ? "rotate(180deg)" : undefined }}
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {archivedOpen &&
          (archivados.length === 0 ? (
            <p className="lab-chats-empty">Nada archivado.</p>
          ) : (
            archivados.map((c) => (
              <SwipeableCard
                key={c.id}
                chat={c}
                active={false}
                onOpen={() => onOpen(c.id)}
                onSwipeLeft={() => onDelete(c.id)}
                onSwipeRight={() => onUnarchive(c.id)}
                rightLabel="Desarchivar"
                rightGlyph="⤒"
              />
            ))
          ))}
      </div>
    </div>
  );
}

export default LabChatsScreen;
