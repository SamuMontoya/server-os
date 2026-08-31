"use client";

// Laboratorio: mismo MOTOR del chat principal (turnos del servidor vía
// apps/agent/src/agent/chat-turns.ts), con el pellejo de Notion en vez del
// HUD. A propósito NO reutiliza el ChatPanel entero (tabs, historial,
// exec bar, voz en tiempo real): esto es el envío/recepción mínimo para
// empezar a vivir acá — el resto (persistencia entre recargas, reenganche
// tras bloquear pantalla, multi-tab) llega en ajustes posteriores.

import { useEffect, useRef, useState } from "react";
import type { ChatToolStep } from "@hermes/shared";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import { useWorkspace } from "@/state/WorkspaceContext";
import { startTurn, attachTurn, fetchTurn, stopTurn } from "@/lib/chat-turns";
import { Markdown } from "@/components/Markdown";
import { LabSteps } from "@/components/LabSteps";
import { LabStatusBar } from "@/components/LabStatusBar";
import { uuid } from "@/lib/uuid";
import { isSupportedImage, uploadChatImage } from "@/lib/chat-attachments";

/**
 * Un tramo de la respuesta, EN EL ORDEN EN QUE PASÓ.
 *
 * Antes la respuesta eran dos campos sueltos —`content` (todo el texto) y
 * `steps` (todas las tools)— y la pantalla los pintaba siempre igual: primero
 * el bloque de pasos, luego el texto. Con eso, un turno que trabaja, explica,
 * vuelve a trabajar y remata se veía como si hubiera hecho TODO al principio
 * y hablado al final. La cronología real se perdía en el modelo de datos.
 *
 * Ahora la respuesta es una lista de bloques que se va armando con el mismo
 * orden de llegada del stream (los eventos del turno vienen numerados por
 * `seq`, ver lib/chat-turns.ts): deltas de texto se pegan al bloque de texto
 * de arriba, tools al bloque de pasos de arriba, y cada cambio de tipo abre
 * un bloque nuevo. Así el hilo queda: acciones → texto → acciones → texto.
 */
type LabBlock =
  | { kind: "text"; text: string }
  | { kind: "steps"; steps: ChatToolStep[] };

type LabMessage = {
  id: number;
  role: "user" | "assistant";
  /** Texto plano del mensaje del usuario. En el asistente vive en `blocks`. */
  content: string;
  /** Respuesta del asistente, en orden cronológico (ver LabBlock). */
  blocks?: LabBlock[];
  /** Imágenes que iban con el mensaje (solo en mensajes del usuario): quedan
   *  visibles en la burbuja, como el adjunto que fueron. */
  images?: { url: string; name: string }[];
};

/** ¿Ya escribió algo el asistente? (para el "pensando" y los avisos de error). */
function blocksText(blocks: LabBlock[] | undefined): string {
  return (blocks ?? [])
    .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Imagen pegada en el composer, mientras vive ahí.
 *
 * `url` es un object URL LOCAL del archivo que soltó el navegador: la
 * miniatura aparece en el mismo frame del pegado, sin esperar al servidor.
 * `id` llega después, cuando termina la subida — hasta entonces el chip se
 * pinta atenuado con spinner y el botón de enviar está bloqueado (mandar el
 * turno sin el id equivaldría a mandar el mensaje sin la imagen).
 */
type LabAttachment = {
  /** Key local estable para React: el id del servidor todavía no existe. */
  key: string;
  id?: string;
  name: string;
  url: string;
  error?: string;
};

export default function Laboratorio() {
  const { selectedProject } = useWorkspace();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<LabMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // Modelo con el que está respondiendo AHORA (lo dice el servidor por el
  // stream, y cambia si el router escala a mitad del turno). Se conserva al
  // terminar: entre mensajes sigue mostrando con qué se respondió el último,
  // que es más informativo que volver a un guion.
  const [model, setModel] = useState<string | null>(null);
  /**
   * Turno vivo AHORA. Lo necesita el botón ⏹ (el mismo botón de enviar
   * mientras se está generando): sin el id no hay a quién mandarle el stop.
   */
  const turnIdRef = useRef<string | null>(null);
  /** Se pidió parar y aún no llegó el `stopped`: el botón se apaga mientras. */
  const [stopping, setStopping] = useState(false);
  /**
   * Contador de interacciones. Cada vez que sube, el pie vuelve a pedir el
   * consumo: lo que se lee bajo el input es el gasto DESPUÉS del turno que se
   * acaba de mandar, no el de la última vez que picó el reloj de un minuto.
   */
  const [usageKey, setUsageKey] = useState(0);
  const bumpUsage = () => setUsageKey((k) => k + 1);
  // Imágenes pegadas que todavía no se han enviado.
  const [attachments, setAttachments] = useState<LabAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Contenedor scrolleable de la conversación + las piezas del "anclaje
  // arriba" (ver scrollAnchorToTop): la burbuja del último mensaje enviado y
  // el colchón elástico que hay debajo de todo para poder subirla.
  const listRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  /**
   * Qué pieza debe quedar pegada arriba. Es la CLAVE de un `data-anchor` del
   * DOM, no un ref a un nodo, porque el ancla ya no es solo el mensaje del
   * usuario: también cada bloque que la IA va insertando (`${msgId}:${i}`).
   * Con refs habría que colgar/quitar un ref condicional en N elementos que se
   * re-renderizan en cada token; una query por atributo se resuelve al medir.
   */
  const anchorKeyRef = useRef<string | null>(null);
  const shrinkPendingRef = useRef(false);
  /**
   * true = Samu scrolleó a mano hacia arriba, así que el auto-anclaje se
   * calla hasta que vuelva al fondo (o envíe otro mensaje). Sin esto, leer
   * una respuesta larga mientras el agente sigue trabajando era imposible:
   * cada bloque nuevo tironeaba la vista.
   */
  const userPinnedRef = useRef(false);
  /**
   * TODOS los object URLs creados en esta visita. Un object URL mantiene el
   * blob vivo hasta que se revoca explícitamente, y las imágenes ya enviadas
   * siguen pintándose en su burbuja — así que no se pueden revocar al enviar.
   * Se sueltan todas juntas al desmontar la página.
   */
  const objectUrlsRef = useRef<string[]>([]);
  // Texto que ya había en el input al arrancar el mic: el dictado se pega
  // detrás, no lo reemplaza (igual que en ChatPanel).
  const dictationBaseRef = useRef("");
  /** true = tirar la próxima transcripción que llegue (ver `endDictation`). */
  const dictationDropRef = useRef(false);

  // Una sesión por visita a la página (igual que un tab nuevo del chat
  // principal). `resume` guarda la sesión del SDK una vez que el primer
  // turno la devuelve, así el segundo mensaje YA tiene el contexto del
  // primero — sin esto, cada envío sería una conversación nueva y suelta.
  const sessionKeyRef = useRef<string | null>(null);
  if (sessionKeyRef.current === null) sessionKeyRef.current = uuid();
  const sdkSessionIdRef = useRef<string | null>(null);
  const unfollowRef = useRef<(() => void) | null>(null);

  // Textarea auto-crecible (hasta ~5 líneas), igual que en ChatPanel.
  //
  // "auto" NO sirve como reset aquí: con el atributo `rows` puesto, un
  // textarea en `height:auto` sigue usando el alto intrínseco de esas filas
  // (así calcula su tamaño por defecto) — nunca se encoge por debajo de eso,
  // así que el scrollHeight medido después seguía siendo el alto "de más"
  // de rows=1. Por eso el placeholder quedaba con hueco debajo aunque ya
  // llamáramos esto al montar. Reseteando a "0px" el navegador SÍ reporta el
  // scrollHeight real del contenido (una línea), sin el piso de `rows`.
  //
  // `toEnd`: una vez el textarea toca su techo (120px) el contenido desborda y
  // el navegador SOLO auto-scrollea al caret cuando el usuario teclea. Al
  // dictar no hay caret moviéndose, así que la última línea quedaba oculta y
  // había que hacer scroll a mano. Con `toEnd` se pega el scroll al fondo.
  const resizeInput = (opts?: { toEnd?: boolean }) => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    if (opts?.toEnd) el.scrollTop = el.scrollHeight;
  };

  // Al montar, con el draft vacío, fija el alto real de una línea en vez de
  // dejar el alto por defecto del navegador (más alto → placeholder pegado
  // arriba con hueco debajo, ver .lab-textarea en globals.css).
  useEffect(() => {
    resizeInput();
  }, []);

  /** Reescribe los bloques del mensaje de respuesta `replyId`. */
  const writeBlocks = (replyId: number, fn: (prev: LabBlock[]) => LabBlock[]) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === replyId ? { ...m, blocks: fn(m.blocks ?? []) } : m)),
    );
  };

  /**
   * Texto que llega por el stream. Se pega al último bloque SI ese bloque ya
   * es de texto; si el último fue de pasos, abre uno nuevo — que es justo lo
   * que colapsa las acciones anteriores (dejan de ser el bloque vivo).
   */
  const appendText = (replyId: number, text: string) => {
    if (!text) return;
    writeBlocks(replyId, (prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "text") {
        return [...prev.slice(0, -1), { kind: "text", text: last.text + text }];
      }
      return [...prev, { kind: "text", text }];
    });
  };

  /** Un tool_use nuevo: se suma al bloque de pasos vivo, o abre uno debajo
   *  del último texto. */
  const appendStep = (replyId: number, step: ChatToolStep) => {
    writeBlocks(replyId, (prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "steps") {
        return [...prev.slice(0, -1), { kind: "steps", steps: [...last.steps, step] }];
      }
      return [...prev, { kind: "steps", steps: [step] }];
    });
  };

  /** Aviso al final de la respuesta (error, desconexión): siempre como texto. */
  const appendNotice = (replyId: number, detail: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== replyId) return m;
        const blocks = m.blocks ?? [];
        const sep = blocksText(blocks).trim() ? "\n\n" : "";
        const last = blocks[blocks.length - 1];
        if (last?.kind === "text") {
          return {
            ...m,
            blocks: [...blocks.slice(0, -1), { kind: "text", text: last.text + sep + detail }],
          };
        }
        return { ...m, blocks: [...blocks, { kind: "text", text: detail }] };
      }),
    );
  };

  // Engancha el stream del turno y va pintando la respuesta a medida que
  // llega. Es la versión mínima de `follow()` en ChatPanel: sin pasos de
  // herramientas ni reenganche tras perder la pestaña — eso llega después.
  const follow = (turnId: string, from: number, replyId: number) => {
    unfollowRef.current?.();
    const close = attachTurn(turnId, from, {
      onState: (st) => {
        // OJO con el snapshot: trae `text` y `steps` como DOS listas planas,
        // sin el orden en que se intercalaron. Reconstruir los bloques desde
        // aquí perdería la cronología (volveríamos a "todas las acciones
        // arriba, todo el texto abajo"), y encima duplicaría contenido: tras
        // el snapshot el servidor RE-EMITE los eventos pendientes desde el
        // cursor, y esos ya reconstruyen la respuesta en orden.
        //
        // Por eso aquí solo se toma lo que no viaja como evento (estado,
        // modelo, sesión). El único caso en que el snapshot manda es
        // `truncated`: el buffer botó eventos, no hay orden que recuperar, y
        // más vale una respuesta completa mal ordenada que una con huecos.
        if (st.truncated) {
          const rebuilt: LabBlock[] = [
            ...(st.steps.length > 0 ? [{ kind: "steps" as const, steps: st.steps }] : []),
            ...(st.text ? [{ kind: "text" as const, text: st.text }] : []),
          ];
          writeBlocks(replyId, () => rebuilt);
          // El cursor de bloques se rehace igual: si quedara desfasado, el
          // ancla apuntaría a un `data-anchor` que ya no existe y el colchón
          // dejaría de medir (anchorOffset → null).
          blockCursorRef.current = {
            replyId,
            count: rebuilt.length,
            lastKind: rebuilt[rebuilt.length - 1]?.kind ?? null,
          };
        }
        setBusy(st.status === "running");
        // El snapshot ya trae el modelo elegido: al reengancharse a un turno
        // en curso el pie no queda en "—" esperando el próximo evento.
        if (st.model) setModel(st.model);
        if (st.sdkSessionId) sdkSessionIdRef.current ??= st.sdkSessionId;
        // OJO: aquí NO se scrollea. La respuesta crece bajo el mensaje
        // anclado; solo se recorta el colchón sobrante (ver shrinkSpacer).
        shrinkSpacer();
      },
      onDelta: (text) => {
        appendText(replyId, text);
        // Un bloque de texto NUEVO (el primero, o el que sigue a unas
        // acciones) sube al borde superior; los deltas siguientes solo
        // recortan el colchón, así se lee sin que la vista persiga al texto.
        if (text) noteBlock(replyId, "text");
        shrinkSpacer();
      },
      onTool: (step) => {
        // Los pasos (tool_use reales) llegan ANTES del primer texto: son lo
        // que reemplaza al "pensando" mudo mientras el agente trabaja. Y si
        // llegan DESPUÉS de un texto, abren un bloque nuevo debajo de él.
        appendStep(replyId, step);
        noteBlock(replyId, "steps");
        shrinkSpacer();
      },
      onSession: (sid) => {
        sdkSessionIdRef.current ??= sid;
      },
      // El router avisa qué modelo puso a correr, y VUELVE a avisar si escala
      // (haiku→sonnet→opus) a mitad del turno: el pie lo refleja en vivo.
      onModel: (m) => setModel(m),
      onEnd: (status) => {
        unfollowRef.current = null;
        turnIdRef.current = null;
        setStopping(false);
        setBusy(false);
        // Terminó un turno = se gastó consumo: el pie se entera ya, no en el
        // próximo tick del minuto.
        bumpUsage();
        if (status === "error") {
          void fetchTurn(turnId).then((st) => {
            appendNotice(replyId, st?.error ? `⚠ ${st.error}` : "⚠ el turno falló");
          });
        }
        shrinkSpacer();
      },
      onDisconnected: () => {
        // Se agotaron los reintentos del navegador; el turno puede seguir
        // vivo en el servidor. De momento se avisa y ya — reengancharse
        // solo al volver es uno de los "ajustes posteriores" pendientes.
        turnIdRef.current = null;
        setStopping(false);
        setBusy(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId && !blocksText(m.blocks).trim()
              ? { ...m, blocks: [{ kind: "text", text: "⚠ se perdió la conexión con Hermes." }] }
              : m,
          ),
        );
      },
    });
    unfollowRef.current = close;
  };

  // ── Anclaje del mensaje enviado arriba ───────────────────────────────
  //
  // Antes esto seguía la respuesta hasta el fondo (`scrollToBottom` en cada
  // delta): con respuestas largas la vista corría sola y no se podía leer
  // desde el principio. Ahora, al enviar, el mensaje del usuario sube al
  // borde superior y la vista SE QUEDA QUIETA mientras Hermes escribe — la
  // respuesta crece hacia abajo y Samu lee/scrollea a su ritmo. Es el
  // comportamiento de ChatGPT, y solo se re-ancla al enviar otro mensaje.
  //
  // Para poder subir el último mensaje hasta arriba tiene que haber altura
  // scrolleable por debajo de él: al principio hay muy poca (la respuesta
  // está vacía). Por eso existe el colchón (`spacerRef`), un div al final que
  // aporta justo los píxeles que faltan y se va ENCOGIENDO a medida que la
  // respuesta los ocupa. Su altura se escribe directo en el DOM (no en
  // estado) para no re-renderizar la lista en cada token del stream.

  /** Hueco que queda sobre el mensaje anclado cuando está pegado arriba. */
  const TOP_GAP = 12;

  /** El nodo anclado ahora mismo (mensaje del usuario o bloque de la IA). */
  const anchorEl = () => {
    const list = listRef.current;
    const key = anchorKeyRef.current;
    if (!list || !key) return null;
    return list.querySelector<HTMLElement>(`[data-anchor="${key}"]`);
  };

  /** Distancia del ancla al inicio del contenido scrolleable, en px. */
  const anchorOffset = () => {
    const list = listRef.current;
    const anchor = anchorEl();
    if (!list || !anchor) return null;
    return anchor.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  };

  /**
   * Recalcula el colchón: exactamente lo necesario para que el ancla pueda
   * quedar a TOP_GAP del borde superior, ni un píxel más (así no aparece un
   * vacío enorme bajo respuestas cortas).
   *
   * `shrinkOnly` durante el stream: dejarlo crecer ahí provocaría tirones si
   * una medición intermedia sale corta (imagen que aún no cargó, bloque de
   * código que se re-mide). Solo el envío de un mensaje nuevo lo re-infla.
   */
  const syncSpacer = (opts?: { shrinkOnly?: boolean }) => {
    const list = listRef.current;
    const sp = spacerRef.current;
    const top = anchorOffset();
    if (!list || !sp || top === null) return;
    // Alto del contenido REAL (sin contar el colchón actual).
    const content = list.scrollHeight - sp.offsetHeight;
    const need = Math.max(0, list.clientHeight - TOP_GAP - (content - top));
    if (opts?.shrinkOnly && need > sp.offsetHeight) return;
    sp.style.height = `${need}px`;
  };

  /** Sube el último mensaje del usuario al borde superior de la lista. */
  const scrollAnchorToTop = () => {
    const list = listRef.current;
    const top = anchorOffset();
    if (!list || top === null) return;
    list.scrollTo({ top: Math.max(0, top - TOP_GAP), behavior: "smooth" });
  };

  /**
   * Ancla `key` arriba. Dos rAF antes de medir: el primero espera al commit de
   * React (el nodo nuevo todavía no está en el DOM cuando vuelve
   * `setMessages`), el segundo al layout ya con el colchón puesto.
   *
   * Si Samu está leyendo más arriba se actualiza la clave pero NO se scrollea:
   * así, cuando vuelva al fondo, el colchón ya mide contra la pieza correcta.
   */
  const anchorTo = (key: string) => {
    anchorKeyRef.current = key;
    if (userPinnedRef.current) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        syncSpacer();
        scrollAnchorToTop();
      });
    });
  };

  /**
   * Cursor de bloques del turno en curso, en paralelo a los `blocks` del
   * estado. Sirve para saber si el próximo evento del stream ABRE un bloque
   * nuevo (→ hay que anclarlo) o sigue engordando el actual (→ la vista no se
   * mueve, si no, cada token daría un tirón). Se lleva en un ref y no en el
   * estado porque `appendText/appendStep` deciden esto ANTES de que React
   * haya commiteado el render anterior.
   */
  const blockCursorRef = useRef<{
    replyId: number | null;
    count: number;
    lastKind: "text" | "steps" | null;
  }>({ replyId: null, count: 0, lastKind: null });

  /** Registra el bloque que acaba de recibir contenido y ancla si es nuevo. */
  const noteBlock = (replyId: number, kind: "text" | "steps") => {
    const cur = blockCursorRef.current;
    if (cur.replyId !== replyId) {
      blockCursorRef.current = { replyId, count: 0, lastKind: null };
    }
    const c = blockCursorRef.current;
    if (c.lastKind === kind) return; // mismo bloque: sigue creciendo, no se toca
    c.lastKind = kind;
    c.count += 1;
    anchorTo(`${replyId}:${c.count - 1}`);
  };

  /**
   * Reengancha el auto-anclaje según dónde quedó la vista. Se dispara con
   * `wheel`/`touchmove` —intención directa de Samu— y no con `scroll`, que
   * también lo emiten nuestros propios `scrollTo` (eso se auto-silenciaría).
   * El rAF es porque en `wheel` el `scrollTop` todavía es el de antes.
   */
  const onUserScroll = () => {
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
      userPinnedRef.current = gap > 120;
    });
  };

  /**
   * Durante el stream: el contenido crece, así que el colchón sobra de a
   * poco. Encogerlo mantiene el scroll máximo justo en el punto donde el
   * ancla está arriba, así que la vista NO se mueve. Throttled a un frame
   * porque esto se llama en cada delta de texto.
   */
  const shrinkSpacer = () => {
    if (shrinkPendingRef.current) return;
    shrinkPendingRef.current = true;
    requestAnimationFrame(() => {
      shrinkPendingRef.current = false;
      syncSpacer({ shrinkOnly: true });
    });
  };

  // ── Imágenes pegadas ─────────────────────────────────────────────────

  /**
   * Mete los archivos en el composer y los sube en paralelo. El chip se pinta
   * ANTES de que arranque la subida (con el object URL local) porque pegar una
   * captura tiene que sentirse instantáneo; el id se rellena cuando llega.
   */
  const addImages = (files: File[]) => {
    const images = files.filter((f) => isSupportedImage(f.type));
    if (images.length === 0) return;
    // Tope alineado con MAX_ATTACHMENTS_PER_TURN del servidor: recortar aquí
    // evita subir archivos que el turno iba a descartar de todas formas.
    const room = Math.max(0, 4 - attachments.length);
    for (const file of images.slice(0, room)) {
      const key = uuid();
      const url = URL.createObjectURL(file);
      objectUrlsRef.current.push(url);
      setAttachments((prev) => [...prev, { key, name: file.name || "captura", url }]);
      void uploadChatImage(file)
        .then((meta) =>
          setAttachments((prev) =>
            prev.map((a) => (a.key === key ? { ...a, id: meta.id, name: meta.name } : a)),
          ),
        )
        .catch((err: unknown) =>
          setAttachments((prev) =>
            prev.map((a) =>
              a.key === key
                ? { ...a, error: err instanceof Error ? err.message : "no se pudo subir" }
                : a,
            ),
          ),
        );
    }
  };

  const removeAttachment = (key: string) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.key === key);
      if (gone) {
        // Esta sí se revoca ya: se descartó sin llegar a ningún mensaje, así
        // que nadie más va a pintar ese blob.
        URL.revokeObjectURL(gone.url);
        objectUrlsRef.current = objectUrlsRef.current.filter((u) => u !== gone.url);
      }
      return prev.filter((a) => a.key !== key);
    });
  };

  /** Alguna imagen todavía subiendo: el envío espera (ver `canSend`). */
  const uploading = attachments.some((a) => !a.id && !a.error);
  /** Solo las que el servidor ya aceptó pueden viajar en el turno. */
  const readyIds = attachments.filter((a) => a.id).map((a) => a.id!);
  const canSend = (draft.trim().length > 0 || readyIds.length > 0) && !busy && !uploading;

  const handleSend = async () => {
    const text = draft.trim();
    // Con imagen y sin texto se envía igual: pegar un pantallazo y darle enviar
    // es una pregunta completa (el servidor pone "¿Qué ves en esta imagen?").
    if (!canSend) return;
    // Corta el dictado Y DESCARTA lo que venga de él.
    //
    // Este era el bug del "input que no queda limpio": `micStop()` no termina
    // el dictado, lo MANDA A TRANSCRIBIR. Un segundo después el servidor
    // devolvía el texto puntuado, el callback hacía `setDraft(base + texto)`
    // y el mensaje recién enviado reaparecía escrito en el composer. Vaciar
    // el draft acá no servía de nada: la respuesta tardía volvía a llenarlo.
    // Ver `dictationDropRef` en el hook de transcripción de abajo.
    endDictation();

    const sent = attachments.filter((a) => a.id);
    const userMsg: LabMessage = {
      id: Date.now(),
      role: "user",
      content: text,
      ...(sent.length ? { images: sent.map((a) => ({ url: a.url, name: a.name })) } : {}),
    };
    const replyMsg: LabMessage = { id: Date.now() + 1, role: "assistant", content: "", blocks: [] };
    // Enviar SIEMPRE re-engancha el auto-anclaje: aunque Samu estuviera
    // leyendo arriba, mandar un mensaje es pedir explícitamente ver lo nuevo.
    userPinnedRef.current = false;
    blockCursorRef.current = { replyId: replyMsg.id, count: 0, lastKind: null };
    setMessages((prev) => [...prev, userMsg, replyMsg]);
    setDraft("");
    // Se vacía el composer SIN revocar los object URLs: los hereda la burbuja,
    // que los sigue pintando. Se sueltan todos al desmontar la página.
    setAttachments([]);
    setBusy(true);
    // El textarea no se re-mide solo al vaciar el value por JS (no dispara
    // onChange); lo hacemos a mano en el próximo frame, cuando el DOM ya
    // tiene el value nuevo.
    requestAnimationFrame(() => resizeInput());
    anchorTo(`u${userMsg.id}`);
    // Mandar es la interacción más informativa para el pie: el consumo que se
    // muestra mientras Hermes piensa ya es el de esta ventana, recién pedido.
    bumpUsage();

    try {
      const turnId = await startTurn({
        message: text,
        sessionKey: sessionKeyRef.current!,
        project: selectedProject,
        resume: sdkSessionIdRef.current,
        attachments: sent.map((a) => a.id!),
      });
      turnIdRef.current = turnId;
      follow(turnId, 0, replyMsg.id);
    } catch (err) {
      turnIdRef.current = null;
      setBusy(false);
      const detail = err instanceof Error ? err.message : "no se pudo enviar el mensaje";
      appendNotice(replyMsg.id, `⚠ ${detail}`);
    }
  };

  /**
   * ⏹ Detener la generación en curso.
   *
   * Se le pide al SERVIDOR que corte el turno (`/chat/turns/:id/stop`), no
   * solo al navegador que deje de escuchar: el turno vive del otro lado y
   * cerrar el stream lo dejaría gastando tokens en una respuesta que ya nadie
   * quiere. El `busy` no se baja aquí a mano — llega el evento `stopped` y con
   * él `onEnd`, que ya limpia todo (así el botón no miente si el stop falla).
   */
  const handleStop = async () => {
    const turnId = turnIdRef.current;
    if (!turnId || stopping) return;
    setStopping(true);
    const ok = await stopTurn(turnId);
    // Si el servidor ni siquiera aceptó el stop (turno ya muerto, agente
    // caído), se suelta la UI igual: dejar el botón bloqueado sería peor.
    if (!ok) {
      setStopping(false);
      setBusy(false);
      turnIdRef.current = null;
      unfollowRef.current?.();
      unfollowRef.current = null;
    }
  };

  // Se cierra el stream (no se cancela el turno: sigue vivo en el servidor)
  // al desmontar, para no seguir escribiendo en un componente que ya no está.
  useEffect(() => () => unfollowRef.current?.(), []);

  // Suelta TODOS los object URLs (composer + burbujas ya enviadas) al salir
  // de la página. Es el único momento seguro: mientras la página vive, una
  // burbuja vieja puede seguir en pantalla usando su URL.
  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  // Pegar una imagen del portapapeles en cualquier punto del textarea. El
  // portapapeles puede traer texto Y una imagen a la vez (captura + "mira
  // esto"): no se hace preventDefault salvo que haya imagen, para no comerse
  // el pegado de texto normal.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    addImages(files);
  };

  const handleDrop = (e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDropping(false);
    addImages(Array.from(e.dataTransfer?.files ?? []));
  };

  // Dictado por voz → texto. El transcript se vuelca automáticamente al draft
  // (por eso no hace falta botón de "aceptar": hablar YA escribe en el input).
  //
  // Dos capas (ver useVoiceDictation): mientras hablas se pinta la vista
  // previa del navegador, y al soltar el botón la reemplaza el texto
  // re-transcrito en el servidor, ya CON puntuación. Como ambas llegan por el
  // mismo callback y siempre parten de `dictationBaseRef`, el reemplazo es
  // simplemente el último `setDraft` que gana.
  const {
    supported: micSupported,
    listening,
    transcribing,
    error: micError,
    start: micStart,
    stop: micStop,
  } = useVoiceDictation({
    onTranscript: (text) => {
      // El dictado ya se envió: este texto es el eco tardío del clip que se
      // acaba de mandar. Escribirlo en el draft resucitaría el mensaje en el
      // composer (ver `endDictation`).
      if (dictationDropRef.current) return;
      const base = dictationBaseRef.current;
      const sep = base && !base.endsWith(" ") ? " " : "";
      setDraft(base + sep + text);
      // En el frame siguiente, NO ahora: `setDraft` aún no ha llegado al DOM,
      // así que medir aquí daba el alto del texto anterior (el textarea iba
      // siempre una línea por detrás al dictar).
      requestAnimationFrame(() => resizeInput({ toEnd: true }));
    },
  });

  /**
   * Cierra el dictado en curso y BLOQUEA su resultado.
   *
   * La transcripción del servidor es asíncrona: `micStop()` solo dispara la
   * subida del clip, y el texto llega después por `onTranscript`. Al enviar,
   * ese texto ya no tiene dónde ir —el mensaje partió— así que se levanta la
   * bandera y el callback lo tira. La bandera se baja al arrancar el próximo
   * dictado, no antes: en medio puede llegar el eco del anterior.
   */
  const endDictation = () => {
    dictationDropRef.current = true;
    dictationBaseRef.current = "";
    if (listening) micStop();
  };

  const toggleMic = () => {
    if (listening) {
      micStop();
      return;
    }
    // Dictado nuevo: vuelve a aceptar transcripciones y ancla la base al texto
    // que ya hubiera escrito a mano.
    dictationDropRef.current = false;
    dictationBaseRef.current = draft.trimEnd();
    void micStart();
    inputRef.current?.focus();
  };

  // El tema del dashboard pinta <html>/<body> casi negros. Como el papel se
  // comprime al viewport visible, cualquier hueco (teclado, rebote del scroll)
  // enseñaba ese fondo. Marcamos la ruta para que el CSS lo ponga en blanco, y
  // lo devolvemos al salir para no contaminar el resto de la app.
  useEffect(() => {
    document.documentElement.classList.add("lab-route");
    return () => document.documentElement.classList.remove("lab-route");
  }, []);

  // Fallback para navegadores que ignoran `interactive-widget=resizes-content`
  // (Safari iOS): ahí el teclado NO encoge el layout viewport, solo desplaza
  // la vista, y el papel se quedaba con el alto de pantalla completa. El
  // resultado era el hueco de abajo que solo se acomodaba scrolleando a mano.
  //
  // Publicamos dos números y el CSS hace el resto:
  //   --lab-vh     → alto REAL visible (sin teclado)  → el papel se comprime
  //   --lab-vp-top → cuánto se desplazó la vista       → el papel la persigue
  // Como la barra de input vive DENTRO del papel (margin-top:auto), ajustar
  // el papel ya la coloca: no hay dos cosas que sincronizar.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Alto de referencia SIN teclado. No sirve comparar contra
    // window.innerHeight: con `interactive-widget=resizes-content` (Chrome)
    // ese número también encoge al abrir el teclado, así que la resta daría 0
    // y nunca detectaríamos nada. Guardamos el máximo visto y solo crece.
    let baseline = vv.height;

    let frame = 0;
    const sync = () => {
      // Coalescemos en un rAF: iOS dispara decenas de resize/scroll durante la
      // animación del teclado y escribir estilos en cada uno provoca tirones.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = document.documentElement;
        root.style.setProperty("--lab-vh", `${vv.height}px`);
        root.style.setProperty("--lab-vp-top", `${vv.offsetTop}px`);
        // Teclado abierto = perdimos un trozo grande de alto visible. 140px de
        // umbral porque la barra de URL de Safari al colapsarse mueve ~60-90px
        // y eso NO es teclado: no queremos recolocar el input por scrollear.
        if (vv.height > baseline) baseline = vv.height;
        root.classList.toggle("lab-kb", baseline - vv.height > 140);
        // El documento no debe scrollear nunca en esta ruta (el CSS lo fija),
        // pero iOS a veces lo empuja igual al enfocar. Lo devolvemos a cero:
        // esto es, literalmente, el scroll manual que Samu tenía que hacer,
        // hecho por nosotros y en el momento correcto.
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };

    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      window.removeEventListener("orientationchange", sync);
      const root = document.documentElement;
      root.style.removeProperty("--lab-vh");
      root.style.removeProperty("--lab-vp-top");
      root.classList.remove("lab-kb");
    };
  }, []);

  return (
    <main className="lab-paper">
      <div className="lab-messages" ref={listRef} onWheel={onUserScroll} onTouchMove={onUserScroll}>
        {messages.map((m, idx) => {
          if (m.role === "user") {
            return (
              <div
                key={m.id}
                className="lab-bubble"
                // `data-anchor`: candidato a quedar pegado arriba. Lo llevan
                // todos los mensajes y bloques; el que manda en cada momento
                // es el que apunta anchorKeyRef (ver anchorTo).
                data-anchor={`u${m.id}`}
              >
                {m.images && m.images.length > 0 && (
                  <div className="lab-bubble-images">
                    {m.images.map((img, i) => (
                      // eslint-disable-next-line @next/next/no-img-element -- object URL local, no un asset de Next.
                      <img key={i} src={img.url} alt={img.name} />
                    ))}
                  </div>
                )}
                {/* El texto va en un <span> (no como nodo de texto suelto) para que
                    `.lab-bubble-images:not(:only-child)` en globals.css detecte que
                    hay hermano: `:only-child` solo cuenta ELEMENTOS, no text nodes. */}
                {m.content ? <span className="lab-bubble-text">{m.content}</span> : null}
              </div>
            );
          }
          const blocks = m.blocks ?? [];
          // Solo el ÚLTIMO mensaje puede estar en curso: es donde escribe el
          // turno activo (busy es global porque solo corre un turno a la vez).
          const streaming = busy && idx === messages.length - 1;
          return (
            <div key={m.id} className="lab-answer">
              {/* La respuesta se pinta EN ORDEN DE LLEGADA: cada bloque de
                  acciones donde de verdad ocurrió, no todos amontonados
                  arriba. Solo el ÚLTIMO bloque de un turno vivo está `live`
                  (una línea, el paso en curso); en cuanto llega texto debajo,
                  ese bloque se pliega solo a "N pasos". */}
              {blocks.map((b, bi) => (
                // El wrapper existe solo por el `data-anchor`: cada bloque que
                // se inserta puede ser el que sube al borde superior, y ni
                // LabSteps ni Markdown reciben ref. Sin padding ni borde, así
                // los márgenes de los hijos siguen colapsando igual que antes.
                <div key={bi} data-anchor={`${m.id}:${bi}`}>
                  {b.kind === "steps" ? (
                    <LabSteps steps={b.steps} live={streaming && bi === blocks.length - 1} />
                  ) : (
                    <Markdown source={b.text} project={selectedProject ?? undefined} />
                  )}
                </div>
              ))}
              {streaming && blocks.length === 0 ? (
                // "Pensando" solo hasta el primer bloque: a partir de ahí los
                // pasos ya cuentan qué está haciendo (igual que ChatPanel).
                <span className="lab-thinking" role="status" aria-label="Hermes está pensando">
                  <span />
                  <span />
                  <span />
                </span>
              ) : null}
            </div>
          );
        })}
        {/* Colchón elástico: altura manejada a mano (ver syncSpacer). Es lo
            que permite subir el último mensaje al borde superior cuando la
            respuesta aún no ocupa la pantalla, y se encoge según ella crece. */}
        <div ref={spacerRef} className="lab-spacer" aria-hidden="true" />
      </div>

      <div className="lab-inputbar">
        <form
          className={`lab-composer ${dropping ? "lab-composer--drop" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          // Soltar un archivo desde el Finder/Explorador encima del composer,
          // no solo pegar del portapapeles — mismo destino (`addImages`).
          onDragOver={(e) => {
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={handleDrop}
        >
          {attachments.length > 0 && (
            <div className="lab-attachments">
              {attachments.map((a) => (
                <div
                  key={a.key}
                  className={`lab-chip ${!a.id && !a.error ? "lab-chip--uploading" : ""} ${a.error ? "lab-chip--error" : ""}`}
                  title={a.error ?? a.name}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- object URL local, no un asset de Next. */}
                  <img src={a.url} alt={a.name} />
                  {!a.id && !a.error && <span className="lab-chip-spin" aria-hidden="true" />}
                  <button
                    type="button"
                    className="lab-chip-x"
                    onClick={() => removeAttachment(a.key)}
                    aria-label={`Quitar ${a.name}`}
                    title="Quitar"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="lab-composer-row">
            {micSupported && (
              <button
                type="button"
                className={`lab-mic ${listening ? "lab-mic--listening" : ""} ${
                  transcribing ? "lab-mic--transcribing" : ""
                }`}
                onClick={toggleMic}
                // Mientras el servidor puntúa el clip el botón se bloquea: si
                // se pudiera rearrancar aquí, el texto que está por llegar
                // pisaría el dictado nuevo.
                disabled={transcribing}
                aria-busy={transcribing}
                aria-label={
                  transcribing
                    ? "Transcribiendo dictado"
                    : listening
                      ? "Detener dictado"
                      : "Dictar por voz"
                }
                aria-pressed={listening}
                title={
                  transcribing
                    ? "Puntuando el dictado…"
                    : listening
                      ? "Detener dictado"
                      : "Dictar por voz"
                }
              >
                {listening ? (
                  <span className="lab-mic-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M6 11a6 6 0 0 0 12 0M12 19v2"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            )}
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                resizeInput();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onPaste={handlePaste}
              placeholder="Escribe algo…"
              aria-label="Entrada de texto"
              className="lab-textarea"
            />
            {/* Un solo botón con dos vidas: flecha para enviar, cuadrado para
                detener mientras se genera. Es el mismo gesto en el mismo sitio
                —el pulgar no tiene que buscar nada— y evita el estado muerto de
                antes, donde el botón se quedaba gris e inútil todo el turno. */}
            {busy ? (
              <button
                type="button"
                className="lab-send lab-send--stop"
                onClick={handleStop}
                disabled={stopping || !turnIdRef.current}
                aria-label="Detener generación"
                title="Detener"
              >
                {/* Cuadrado de "stop" de toda la vida: relleno, esquinas
                    apenas redondeadas, del mismo tamaño óptico que la flecha. */}
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                className="lab-send"
                disabled={!canSend}
                aria-label="Enviar"
                title="Enviar"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </form>
        {/* Fallo del dictado (permiso denegado, sin transcriptor…). Antes se
            perdía en silencio: el micrófono simplemente no hacía nada. */}
        {micError && (
          <p className="lab-mic-error" role="status">
            {micError}
          </p>
        )}
        {/* Pie: consumo · modelo en curso · reloj de reinicio. Vive DENTRO de
            la barra (no del form) para que comparta su ancho máximo y se
            mueva con ella cuando el teclado la empuja. */}
        <LabStatusBar model={model} refreshKey={usageKey} />
      </div>
    </main>
  );
}
