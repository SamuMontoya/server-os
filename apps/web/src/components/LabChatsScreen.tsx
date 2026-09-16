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
 *
 * Papelera (pedido de Jaime 2026-09-16): swipe a la izquierda ya no borra un
 * chat de una — lo manda a la papelera (`status: "trashed"` en LabThread, ver
 * lab-persist.ts) con 30 días de gracia antes de que `laboratorio/page.tsx`
 * lo purgue solo (mismo plazo que el servidor, ver TRASH_RETENTION_MS en
 * chat-threads.ts del agente). Esta pantalla solo pinta la sección
 * colapsable al fondo de la lista (cerrada por defecto: es un rincón de
 * "por si acaso", no algo que se consulte seguido) con el tiempo restante de
 * cada uno y el botón "Restaurar" — sordo, como el resto del componente, a
 * cómo se calcula ese plazo o qué pasa al restaurar.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { OrbeIA } from "@/components/orbe/OrbeIA";

/** Cuántas filas se pintan por tanda. Con el tope real de chats (40 en
 *  localStorage, 60 en el servidor — ver lab-persist.ts) casi nunca hace
 *  falta una segunda tanda, pero si algún día sube el límite la lista no
 *  monta cientos de filas de una: solo pinta de más cuando el "centinela"
 *  del fondo entra en pantalla (ver scroll infinito, abajo). */
const CHATS_BATCH_SIZE = 24;

/** Un chat en la papelera: alcanza con título + cuándo se borró — no lleva
 *  `preview`/`running`/`unread` porque un chat trashed no se puede abrir, así
 *  que ninguno de esos datos tiene dónde mostrarse. */
export interface LabTrashedChatSummary {
  id: string;
  title: string;
  /** `Date.now()` de cuando se eliminó — de ahí sale la cuenta regresiva de
   *  30 días (ver `formatExpiry`) y el orden (más reciente primero). */
  trashedAt: number;
}

export interface LabChatSummary {
  id: string;
  /** Nombre corto del chat (lo genera haiku; si no, el recorte del 1er mensaje). */
  title: string;
  /** Última cosa dicha en el chat, recortada: la segunda línea de la card. */
  preview?: string;
  updatedAt: number;
  /** true = tenía (o tiene) un turno corriendo la última vez que se supo. */
  running: boolean;
  /** true = tiene actividad más nueva que la última vez que Samu lo abrió
   *  (ver `seenAt` en lab-persist.ts) — pinta la fila con fondo gris claro.
   *  El chat activo (el que está abierto ahora) nunca llega en true: ver
   *  `listChatsForProject` en laboratorio/page.tsx. */
  unread: boolean;
}

interface Props {
  chats: LabChatSummary[];
  activeId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Deslizar hacia abajo desde el tope de la lista vuelve a pedirle al
   *  servidor los chats de otros dispositivos (ver syncThreadsFromServer en
   *  laboratorio/page.tsx) — el sync automático al entrar cubre el caso
   *  normal, esto es el respaldo manual para cuando alguien no quiere
   *  esperar o sospecha que algo quedó desactualizado. Opcional: sin él
   *  (pantallas de prueba) el gesto simplemente no hace nada. */
  onRefresh?: () => Promise<void> | void;
  /** Vacío = no se pinta ninguna sección de papelera (ver `TrashSection`). */
  trashedChats?: LabTrashedChatSummary[];
  onRestore?: (id: string) => void;
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

/** Mismo plazo que `TRASH_RETENTION_MS` del servidor (chat-threads.ts del
 *  agente) — duplicado a propósito: es una constante de UI (cuenta regresiva
 *  visible), no lógica de negocio que deba importarse desde el backend. Si
 *  algún día cambia el plazo, hay que tocar los dos lados (búscalo por este
 *  comentario). */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** "Se elimina hoy" / "Se elimina en 1 día" / "Se elimina en 12 días" — la
 *  cuenta regresiva de cada fila de la papelera. Redondea hacia ARRIBA
 *  (`Math.ceil`) para no decir "0 días" mientras todavía falta una fracción
 *  de día real: es mejor pecar de conservador ("hoy") que prometer más
 *  tiempo del que en verdad queda. */
function formatExpiry(trashedAt: number): string {
  const msLeft = trashedAt + TRASH_RETENTION_MS - Date.now();
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  if (daysLeft <= 0) return "Se elimina hoy";
  if (daysLeft === 1) return "Se elimina en 1 día";
  return `Se elimina en ${daysLeft} días`;
}

/**
 * Sección colapsable al fondo de la lista con los chats eliminados —
 * cerrada por defecto (pedido implícito de no ensuciar la vista principal
 * con algo que se consulta poco). Cada fila es SOLO título + cuenta
 * regresiva + botón "Restaurar": a diferencia de `SwipeableCard`, un chat
 * trashed no se puede abrir (no hay turno ni mensajes que mostrar en esta
 * pantalla — `laboratorio/page.tsx` ya lo sacó de `chatsRef` "en vivo"), así
 * que no lleva gesto de swipe ni `onClick` propio.
 */
function TrashSection({
  chats,
  onRestore,
}: {
  chats: LabTrashedChatSummary[];
  onRestore: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => [...chats].sort((a, b) => b.trashedAt - a.trashedAt), [chats]);

  if (sorted.length === 0) return null;

  return (
    <div className="lab-chats-trash">
      <button
        type="button"
        className="lab-chats-trash-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="lab-chats-trash-list"
      >
        <span className="lab-chats-trash-label">Papelera</span>
        <span className="lab-chats-trash-count">{sorted.length}</span>
        <span
          className={`lab-chats-trash-chevron ${open ? "lab-chats-trash-chevron--open" : ""}`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      {open && (
        <ul className="lab-chats-trash-list" id="lab-chats-trash-list">
          {sorted.map((c) => (
            <li key={c.id} className="lab-chats-trash-row">
              <div className="lab-chats-trash-info">
                <span className="lab-chats-trash-title">{c.title}</span>
                <span className="lab-chats-trash-expiry">{formatExpiry(c.trashedAt)}</span>
              </div>
              <button
                type="button"
                className="lab-chats-trash-restore"
                onClick={() => onRestore(c.id)}
              >
                Restaurar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
        className={`lab-chatcard ${active ? "lab-chatcard--active" : ""} ${
          chat.unread ? "lab-chatcard--idle" : ""
        }`}
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
        {/* Avatar líder: SOLO existe mientras el turno está TRABAJANDO — el
            orbe animado. En cualquier otro estado no hay avatar ni punto de
            ningún tipo: el contenido es solo título + descripción, sin nada
            más a la izquierda (pedido de Samu 2026-09-07).
            El fondo gris de la fila (`.lab-chatcard--idle`, ver globals.css)
            es un asunto DISTINTO: no depende de `running` sino de
            `chat.unread` — solo se tiñe el chat que tiene cambios más
            nuevos que la última vez que Samu lo abrió (corrección de Samu
            el mismo día: al principio CUALQUIER chat en reposo se pintaba
            de gris, y debía ser nada más el que está pendiente de leer). */}
        {chat.running && (
          <div className="lab-chatcard-avatar">
            <OrbeIA tam="32px" ojos={false} ariaLabel="Trabajando" />
          </div>
        )}
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
          {/* Segundo renglón: SIEMPRE poblado mientras corre — cae a
              "Pensando…" si `chat.preview` no tiene nada todavía (ver
              derivePreview en laboratorio/page.tsx, que cae al último
              mensaje del usuario si el asistente aún no contestó), o se le
              fuerza el "…" al final para dejar claro que sigue en marcha,
              sin duplicarlo si `chat.preview` ya lo trae. El AVATAR de
              arriba ya dice "esto sigue vivo": este texto solo aporta el
              contenido, ya no lleva el orbe embebido. */}
          {chat.running ? (
            <span className="lab-chatcard-preview">
              {chat.preview
                ? chat.preview.endsWith("…")
                  ? chat.preview
                  : `${chat.preview}…`
                : "Pensando…"}
            </span>
          ) : chat.preview ? (
            <span className="lab-chatcard-preview">{chat.preview}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Cuánto hay que arrastrar (px) antes de que soltar dispare el refresh —
 *  más corto que el swipe de eliminar porque acá no hay riesgo de acción
 *  destructiva por error: en el peor caso, un fetch de más. */
const PULL_COMMIT_PX = 60;
/** Tope visual del arrastre: pasado esto ya no cede más (con damping, ver
 *  onPointerMove) — sin tope, arrastrar mucho estira el indicador fuera de
 *  toda proporción. */
const PULL_MAX_PX = 90;

export function LabChatsScreen({
  chats,
  activeId,
  onClose,
  onOpen,
  onDelete,
  onRefresh,
  trashedChats,
  onRestore,
}: Props) {
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
  // Área completa de la pantalla (orbe + buscador + lista) — el gesto de
  // pull-to-refresh escucha ACÁ, no solo en `.lab-chats-list`: el pulgar de
  // alguien que quiere "jalar desde arriba" naturalmente puede arrancar
  // sobre el orbe grande o el buscador, que están por fuera del scroll.
  // Atarlo solo a la lista lo dejaba mudo la mitad de las veces.
  const screenRef = useRef<HTMLDivElement | null>(null);
  // Sin chats activos pero CON papelera (p. ej. se acaba de borrar el único
  // chat que había): no cae en el estado "vacío" de abajo — ese mensaje
  // ("Aún no hay chats aquí") sería falso mientras la papelera sí tiene algo
  // que mostrar (y restaurar).
  const trashed = trashedChats ?? [];

  // ── Pull-to-refresh ─────────────────────────────────────────────────
  // Deslizar hacia abajo desde el TOPE de la lista (scrollTop === 0) vuelve
  // a pedir los chats al servidor — el respaldo manual que pidió Samu para
  // cuando cambia de dispositivo y el sync automático al entrar no alcanzó
  // a traer lo último (o simplemente no quiere esperar a averiguarlo).
  //
  // OJO — por qué esto es `touchstart/move/end` a mano y NO Pointer Events
  // por JSX (como SwipeableCard, arriba): un swipe HORIZONTAL no compite con
  // nada, así que el navegador nunca interviene y los Pointer Events de React
  // bastan. Un pull VERTICAL en el TOPE de una lista scrolleable sí compite
  // directo con el rebote nativo (rubber-band) de iOS — Safari le entrega el
  // gesto a su propio scroll ANTES de que el pointermove de React alcance a
  // hacer nada útil, así que el arrastre nunca se sentía (el bug real que
  // reportó Samu). La única forma confiable de ganarle esa carrera es
  // `touchmove` con `{ passive: false }` + `preventDefault()` en el momento
  // exacto en que se confirma que es un pull — y React SIEMPRE adjunta los
  // handlers `onTouchMove` del JSX como passive (no permite preventDefault
  // ahí), así que el listener tiene que ir con `addEventListener` a mano.
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const pullingRef = useRef(false);
  const pullStartYRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const target = screenRef.current;
    if (!target || !onRefresh) return;
    // El SCROLL que importa es el de la lista (el orbe/buscador de arriba
    // no scrollean) — se lee de `listRef`, aunque el listener esté puesto
    // en `screenRef` (el área completa donde puede arrancar el dedo).
    const atTop = () => (listRef.current?.scrollTop ?? 0) <= 0;

    const commit = (y: number) => {
      pullingRef.current = false;
      if (y >= PULL_COMMIT_PX && onRefreshRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPullY(PULL_COMMIT_PX);
        void Promise.resolve(onRefreshRef.current()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          setPullY(0);
        });
      } else {
        setPullY(0);
      }
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      pullingRef.current = !refreshingRef.current && atTop();
      pullStartYRef.current = t.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!pullingRef.current) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - pullStartYRef.current;
      if (dy <= 0 || !atTop()) {
        // Ya no es un pull de verdad (se devolvió o el usuario terminó
        // scrolleando contenido): se suelta sin tocar el scroll nativo.
        pullingRef.current = false;
        setPullY(0);
        return;
      }
      // A partir de acá SÍ es nuestro gesto: se le quita el control al
      // scroll nativo (si no, además del indicador se vería el rebote
      // elástico de iOS de fondo, dos animaciones peleando a la vez).
      e.preventDefault();
      // Damping tipo "elástico": raíz cuadrada en vez de 1:1, cede rápido
      // al principio y cada vez menos cuanto más se arrastra.
      setPullY(Math.min(PULL_MAX_PX, Math.sqrt(dy) * 6));
    };
    const onEnd = () => {
      if (!pullingRef.current) return;
      setPullY((y) => {
        commit(y);
        return y;
      });
    };

    // `passive: false` es EL punto de todo esto: sin él, `preventDefault()`
    // de arriba no hace nada y Safari se queda con el gesto igual.
    target.addEventListener("touchstart", onStart, { passive: true });
    target.addEventListener("touchmove", onMove, { passive: false });
    target.addEventListener("touchend", onEnd, { passive: true });
    target.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      target.removeEventListener("touchstart", onStart);
      target.removeEventListener("touchmove", onMove);
      target.removeEventListener("touchend", onEnd);
      target.removeEventListener("touchcancel", onEnd);
    };
    // Dependencia por `!!onRefresh` (booleano) y no por `onRefresh` a secas:
    // page.tsx pasa una función NUEVA en cada render (arrow inline), así que
    // depender de la referencia desataría y reataría los listeners en CADA
    // render del padre — incluido a mitad de un gesto en curso. La función
    // de verdad siempre se lee fresca vía `onRefreshRef.current`, así que
    // solo hace falta re-atar cuando pasa de tener handler a no tenerlo (o
    // viceversa), o cuando la lista aparece/desaparece.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!onRefresh, chats.length === 0]);

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
    <div className="lab-chats-screen" ref={screenRef} role="dialog" aria-modal="true" aria-label="Chats">
      {/* SIN barra propia: el Navbar del Laboratorio queda por encima de esta
          capa (z-index:3 vs 2) y sigue activo, así que la hamburguesa ya
          cierra la lista y el "+" ya crea un chat. Dibujar aquí otra ✕ y otro
          "+" era duplicar los mismos dos controles en las mismas dos
          esquinas. El hueco de la barra lo reserva el padding-top de
          .lab-chats-screen. */}
      {chats.length === 0 && trashed.length === 0 ? (
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
          {/* El gesto de pull-to-refresh se ata solo en el useEffect de
              arriba (necesita `{ passive: false }`, que JSX no permite) —
              este div no lleva props de touch/pointer para eso. */}
          <div className="lab-chats-list" ref={listRef}>
            {/* Indicador de pull-to-refresh: vive DENTRO del scroll, arriba
                de la primera card, y solo ocupa alto real (empuja las cards
                hacia abajo) mientras se arrastra o está refrescando — el
                resto del tiempo es un nodo de 0px, invisible de verdad y no
                solo con opacity:0 (que igual reservaría espacio). */}
            {onRefresh && (pullY > 0 || refreshing) && (
              <div
                className={`lab-chats-pull ${refreshing ? "lab-chats-pull--active" : ""}`}
                style={{ height: refreshing ? PULL_COMMIT_PX : pullY }}
                aria-hidden="true"
              >
                <span
                  className="lab-chip-spin"
                  style={
                    refreshing
                      ? undefined
                      : { opacity: Math.min(1, pullY / PULL_COMMIT_PX), animationPlayState: "paused" }
                  }
                />
              </div>
            )}
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
            {/* La papelera no se filtra por `query`: buscar es para encontrar
                un chat con el que seguir hablando, no para escarbar en lo
                que ya se eliminó. */}
            <TrashSection chats={trashed} onRestore={onRestore ?? (() => {})} />
          </div>
        </>
      )}
    </div>
  );
}

export default LabChatsScreen;
