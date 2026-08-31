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
import { startTurn, attachTurn, fetchTurn, fetchTurnResilient, stopTurn } from "@/lib/chat-turns";
import { Markdown } from "@/components/Markdown";
import { LabSteps } from "@/components/LabSteps";
import { LabStatusBar } from "@/components/LabStatusBar";
import { uuid } from "@/lib/uuid";
import { isSupportedImage, uploadChatImage } from "@/lib/chat-attachments";
import { OrbeIA } from "@/components/orbe/OrbeIA";
import {
  loadLab,
  saveLab,
  chatStorageKey,
  type HydratedLab,
  type LabBlock,
  type LabMessage,
  type LabThread,
  type PendingLabTurn,
} from "@/lib/lab-persist";
import { LabChatsScreen, type LabChatSummary } from "@/components/LabChatsScreen";

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
 *
 * LabBlock/LabMessage viven en lib/lab-persist.ts (no aquí): ese módulo es el
 * que además sabe guardarlos y recortarlos para localStorage, y necesita los
 * tipos para su propio contrato — mejor una sola definición que dos copias.
 */

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
  const projKey = selectedProject || "general";

  // Hidratación: UNA lectura del navegador en el primer render. Sin esto,
  // cada remontaje —y iOS remonta cada vez que recupera la pestaña que mató
  // en segundo plano, o simplemente al volver a abrir la app— arrancaba un
  // chat nuevo y vacío sobre una conversación que seguía existiendo en el
  // servidor. Mismo patrón que ChatPanel (lib/chat-persist.ts), en su propio
  // storage (lib/lab-persist.ts) para no mezclar los dos historiales.
  const hydratedRef = useRef<HydratedLab | null | undefined>(undefined);
  if (hydratedRef.current === undefined) hydratedRef.current = loadLab();

  // Con VARIOS chats por proyecto (antes uno solo) hay que decidir, al
  // arrancar, cuál de los del proyecto en foco es "el activo": el que
  // `activeByProject` recuerda si sigue vivo y sin archivar, o si no el más
  // reciente sin archivar de ese proyecto, o si no hay ninguno, uno nuevo en
  // blanco. Se resuelve UNA vez (mismo truco de ref-lazy-init que ya usa
  // `sessionKeyRef` más abajo) para que el resto del componente pueda seguir
  // tratando "el chat activo" como si fuera el único, igual que antes.
  const initRef = useRef<{ activeChatId: string; thread: LabThread | null } | undefined>(undefined);
  if (initRef.current === undefined) {
    const byChat = hydratedRef.current?.byChat ?? {};
    const savedId = hydratedRef.current?.activeByProject[projKey];
    let chosenId: string | null = null;
    let chosenThread: LabThread | null = null;
    if (savedId) {
      const t = byChat[chatStorageKey(projKey, savedId)];
      if (t && !t.archived) {
        chosenId = savedId;
        chosenThread = t;
      }
    }
    if (!chosenThread) {
      for (const [key, t] of Object.entries(byChat)) {
        if (!key.startsWith(`${projKey}::`) || t.archived) continue;
        if (!chosenThread || t.updatedAt > chosenThread.updatedAt) chosenThread = t;
      }
      chosenId = chosenThread?.id ?? null;
    }
    initRef.current = { activeChatId: chosenId ?? uuid(), thread: chosenThread };
  }
  // Copia local: TS no estrecha `initRef.current` como definido a través de
  // dos statements separados, y esto se lee varias veces más abajo.
  const init = initRef.current;
  const initialThread = init.thread;

  const [draft, setDraft] = useState(initialThread?.draft ?? "");
  const [messages, setMessages] = useState<LabMessage[]>(initialThread?.messages ?? []);
  // `busy` NUNCA se hidrata como true: al rehidratar, quien decide si hay algo
  // corriendo es el turno pendiente (verificable contra el servidor vía
  // `resumePending`), no un booleano viejo — un `busy` fósil dejaba el
  // composer bloqueado para siempre.
  const [busy, setBusy] = useState(false);
  // Modelo con el que está respondiendo AHORA (lo dice el servidor por el
  // stream, y cambia si el router escala a mitad del turno). Se conserva al
  // terminar: entre mensajes sigue mostrando con qué se respondió el último,
  // que es más informativo que volver a un guion.
  const [model, setModel] = useState<string | null>(initialThread?.model ?? null);
  /**
   * Turno vivo AHORA. Lo necesita el botón ⏹ (el mismo botón de enviar
   * mientras se está generando): sin el id no hay a quién mandarle el stop.
   * Arranca en null aunque hubiera un turno pendiente guardado: se confirma
   * contra el servidor en `resumePending` antes de darlo por vivo.
   */
  const turnIdRef = useRef<string | null>(null);
  /**
   * Turno que este hilo dejó corriendo, tal como se guardó (o null si no
   * había). Es lo que `resumePending` intenta reenganchar al montar y al
   * volver de segundo plano; se limpia cuando el turno cierra de verdad.
   */
  const pendingTurnRef = useRef<PendingLabTurn | null>(initialThread?.pendingTurn ?? null);
  /**
   * Cursor `seq` más alto visto del turno EN VUELO. Se persiste como parte de
   * `pendingTurn` para que un reenganche futuro pida el replay exacto desde
   * ahí (ni de más — duplicaría texto ya pintado — ni de menos — perdería
   * texto). Monótono: solo sube.
   */
  const lastSeqRef = useRef(0);
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
  /** true = hay suficiente texto por encima del fondo como para mostrar el
   *  botón circular de "ir al final" sobre el composer. */
  const [showJumpDown, setShowJumpDown] = useState(false);
  /** true = está abierta la pantalla de "chats abiertos" (menú hamburguesa). */
  const [showChats, setShowChats] = useState(false);
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

  // Una sesión por HILO persistido (antes era "una por visita a la página":
  // con la persistencia, recargar ya no debe partir la conversación en dos).
  // `resume` guarda la sesión del SDK una vez que el primer turno la
  // devuelve, así el segundo mensaje YA tiene el contexto del primero — sin
  // esto, cada envío sería una conversación nueva y suelta.
  const sessionKeyRef = useRef<string | null>(null);
  if (sessionKeyRef.current === null) {
    sessionKeyRef.current = initialThread?.sessionKey || uuid();
  }
  const sdkSessionIdRef = useRef<string | null>(initialThread?.sdkSessionId ?? null);
  const unfollowRef = useRef<(() => void) | null>(null);

  /** Id del chat activo ahora mismo (el que vive en `messages`/`draft`/etc.
   *  de arriba). Con un solo chat por proyecto esto no hacía falta; ahora
   *  puede haber varios, y todo lo que no es el activo vive "guardado" en
   *  `chatsRef`, no en el estado de React (nadie lo pinta mientras no está
   *  en foco). */
  const activeChatIdRef = useRef(init.activeChatId);
  /** TODOS los demás chats (de este proyecto y de otros), guardados por
   *  referencia — igual que `byProject` en ChatPanel, un nivel más profundo
   *  (antes era un hilo por proyecto; ahora son varios). Clave =
   *  `chatStorageKey(proyecto, chat.id)`. */
  const chatsRef = useRef(
    new Map<string, LabThread>(
      Object.entries(hydratedRef.current?.byChat ?? {}).filter(
        ([key]) => key !== chatStorageKey(projKey, init.activeChatId),
      ),
    ),
  );
  /** proyecto → id del chat que se retoma ahí. Se persiste tal cual. */
  const activeByProjectRef = useRef<Record<string, string>>({
    ...(hydratedRef.current?.activeByProject ?? {}),
    [projKey]: init.activeChatId,
  });
  const prevProjRef = useRef(projKey);
  /** Sube cada vez que `chatsRef`/`activeChatIdRef` cambian por fuera de un
   *  render (crear/archivar/borrar/cambiar de chat): es lo único que hace
   *  falta para que la pantalla de chats (que lee esos refs directamente)
   *  se vuelva a pintar. */
  const [chatsVersion, setChatsVersion] = useState(0);
  const bumpChatsVersion = () => setChatsVersion((v) => v + 1);

  // Refs-espejo del estado React: `persistNow` necesita leer el valor MÁS
  // RECIENTE aunque se dispare fuera de un render (debounce, pagehide). Se
  // actualizan en cada render, igual que `stateRef.current = state` en
  // ChatPanel.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const modelRef = useRef(model);
  modelRef.current = model;

  /** Snapshot del chat activo, tal como debe guardarse ahora mismo. */
  const buildThread = (overrides?: Partial<LabThread>): LabThread => ({
    id: activeChatIdRef.current,
    archived: false,
    updatedAt: Date.now(),
    sdkSessionId: sdkSessionIdRef.current,
    sessionKey: sessionKeyRef.current ?? "",
    messages: messagesRef.current,
    draft: draftRef.current,
    model: modelRef.current,
    pendingTurn: pendingTurnRef.current ?? undefined,
    ...overrides,
  });

  /** Vuelca el chat activo dentro de `chatsRef` (con sus overrides, p. ej.
   *  `{archived: true}`), SIN cambiar cuál es el chat en foco. Primer paso de
   *  cualquier cambio de chat: guardar antes de reemplazar lo que se ve. */
  const saveActiveIntoMap = (overrides?: Partial<LabThread>) => {
    chatsRef.current.set(chatStorageKey(projKey, activeChatIdRef.current), buildThread(overrides));
  };

  const persistNow = () => {
    const byChat = Object.fromEntries(chatsRef.current);
    byChat[chatStorageKey(projKey, activeChatIdRef.current)] = buildThread();
    saveLab(byChat, activeByProjectRef.current);
  };
  const persistNowRef = useRef(persistNow);
  persistNowRef.current = persistNow;
  /** Guardar tras una mutación fuera de render (setState es asíncrono: llamar
   *  a persistNow() en la misma línea guardaría el estado ANTERIOR). */
  const schedulePersist = () => setTimeout(() => persistNowRef.current(), 0);

  // ── Varios chats por proyecto ────────────────────────────────────────
  //
  // Antes había un solo hilo por proyecto; ahora puede haber varios (pantalla
  // de la lista, ver LabChatsScreen), cada uno con su propio turno. El
  // servidor (chat-turns.ts) ya corre turnos en paralelo sin pisarse por
  // sesión ni proyecto — lo único que hay AQUÍ es "cuál de esos chats es el
  // que se ve ahora mismo". Cambiar de chat es la MISMA operación que cambiar
  // de proyecto (ver el efecto de `projKey` más abajo), un nivel más
  // profundo: guardar el actual en `chatsRef`, cargar el otro en el estado.
  //
  // IMPORTANTE (alcance de "paralelo" en esta versión): el turno de un chat
  // en segundo plano sigue corriendo en el servidor sin importar si alguien
  // lo mira — eso es gratis, viene del motor. Lo que NO hace esta versión es
  // mostrar el streaming en vivo de dos chats a la vez: al volver a uno que
  // quedó trabajando, `resumePending` lo reengancha y se pone al día de una,
  // no palabra por palabra. Ver DECISIONES.md si algún día hace falta más.

  /** Primeras palabras del primer mensaje del usuario — lo que se ve en la
   *  card de la lista cuando el chat no tiene título propio. */
  const deriveTitle = (msgs: LabMessage[]): string => {
    const first = msgs.find((m) => m.role === "user" && m.content.trim());
    if (!first) return "Chat nuevo";
    const flat = first.content.trim().replace(/\s+/g, " ");
    return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
  };

  /** Todos los chats de un proyecto, activo incluido, para pintar la lista.
   *  Lee `chatsRef` + (si es el proyecto en foco) el estado de arriba. */
  const listChatsForProject = (pk: string): LabChatSummary[] => {
    const out: LabChatSummary[] = [];
    if (pk === projKey) {
      out.push({
        id: activeChatIdRef.current,
        title: deriveTitle(messagesRef.current),
        updatedAt: Date.now(),
        archived: false,
        running: busy || !!pendingTurnRef.current,
      });
    }
    for (const [key, t] of chatsRef.current) {
      if (!key.startsWith(`${pk}::`)) continue;
      out.push({
        id: t.id,
        title: deriveTitle(t.messages),
        updatedAt: t.updatedAt,
        archived: t.archived,
        running: !!t.pendingTurn,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  };

  /** Reemplaza lo que hay en `messages`/`draft`/etc. por el chat `id` (o uno
   *  en blanco si `thread` es null). Asume que quien llama YA decidió qué
   *  hacer con el chat que se estaba viendo (guardarlo, archivarlo, nada). */
  const loadChatIntoState = (id: string, thread: LabThread | null) => {
    unfollowRef.current?.();
    unfollowRef.current = null;
    chatsRef.current.delete(chatStorageKey(projKey, id));
    activeChatIdRef.current = id;
    activeByProjectRef.current[projKey] = id;
    turnIdRef.current = null;
    setStopping(false);
    sdkSessionIdRef.current = thread?.sdkSessionId ?? null;
    sessionKeyRef.current = thread?.sessionKey || uuid();
    pendingTurnRef.current = thread?.pendingTurn ?? null;
    lastSeqRef.current = thread?.pendingTurn?.seq ?? 0;
    setMessages(thread?.messages ?? []);
    setDraft(thread?.draft ?? "");
    setModel(thread?.model ?? null);
    setBusy(false);
    // Si el chat que se abre tenía un turno vivo, intenta reengancharse.
    resumePendingRef.current();
  };

  /** El primer chat no archivado del proyecto que encuentre en `chatsRef`, o
   *  uno nuevo en blanco si no queda ninguno — para no dejar el Laboratorio
   *  sin chat activo tras archivar/borrar el que se estaba viendo. */
  const loadAnyOtherChat = () => {
    for (const [key, t] of chatsRef.current) {
      if (key.startsWith(`${projKey}::`) && !t.archived) {
        loadChatIntoState(t.id, t);
        return;
      }
    }
    loadChatIntoState(uuid(), null);
  };

  const switchToChat = (id: string) => {
    if (id === activeChatIdRef.current) {
      setShowChats(false);
      return;
    }
    saveActiveIntoMap();
    const thread = chatsRef.current.get(chatStorageKey(projKey, id)) ?? null;
    loadChatIntoState(id, thread);
    setShowChats(false);
    schedulePersist();
  };

  const createNewChat = () => {
    saveActiveIntoMap();
    loadChatIntoState(uuid(), null);
    setShowChats(false);
    schedulePersist();
  };

  /** Swipe a la derecha en la lista: archivar. Si es el chat activo, hay que
   *  dejar OTRO en foco (no se puede archivar y seguir viéndolo). */
  const archiveChat = (id: string) => {
    if (id === activeChatIdRef.current) {
      saveActiveIntoMap({ archived: true });
      loadAnyOtherChat();
    } else {
      const key = chatStorageKey(projKey, id);
      const t = chatsRef.current.get(key);
      if (t) chatsRef.current.set(key, { ...t, archived: true });
    }
    schedulePersist();
    bumpChatsVersion();
  };

  const unarchiveChat = (id: string) => {
    const key = chatStorageKey(projKey, id);
    const t = chatsRef.current.get(key);
    if (t) chatsRef.current.set(key, { ...t, archived: false, updatedAt: Date.now() });
    schedulePersist();
    bumpChatsVersion();
  };

  /** Swipe a la izquierda: eliminar. No cancela el turno en el servidor si
   *  seguía vivo (igual que cerrar un tab en ChatPanel) — solo se deja de
   *  escuchar y de guardar localmente. */
  const deleteChat = (id: string) => {
    if (id === activeChatIdRef.current) {
      unfollowRef.current?.();
      unfollowRef.current = null;
      loadAnyOtherChat();
    } else {
      chatsRef.current.delete(chatStorageKey(projKey, id));
    }
    schedulePersist();
    bumpChatsVersion();
  };

  /**
   * Reenganche perezoso: `follow` (más abajo) necesita poder llamar a
   * `resumePending` (definida más abajo aún, ya que usa `follow`) apenas se
   * desconecta. Un ref indirecto rompe el ciclo sin reordenar todo el
   * archivo — se asigna la función real más abajo, en cada render.
   */
  const resumePendingRef = useRef<() => void>(() => {});
  /** true = ya hay un reintento acotado de `resumePending` agendado (ver
   *  fetchTurnResilient devolviendo null): evita apilar varios si visible +
   *  online se disparan casi juntos al volver de segundo plano. */
  const resumeRetryPendingRef = useRef(false);

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
        // Cursor de replay: se persiste como parte de `pendingTurn` para que
        // un reenganche futuro (recargar, volver de segundo plano) pida el
        // replay exacto desde aquí — ni de más (duplicaría texto), ni de
        // menos (perdería texto). Monótono, igual que en chat-turns.ts.
        lastSeqRef.current = Math.max(lastSeqRef.current, st.seq);
        pendingTurnRef.current =
          st.status === "running" ? { id: turnId, seq: lastSeqRef.current } : null;
        // OJO: aquí NO se scrollea. La respuesta crece bajo el mensaje
        // anclado; solo se recorta el colchón sobrante (ver shrinkSpacer).
        shrinkSpacer();
      },
      onDelta: (text, seq) => {
        appendText(replyId, text);
        // Un bloque de texto NUEVO (el primero, o el que sigue a unas
        // acciones) sube al borde superior; los deltas siguientes solo
        // recortan el colchón, así se lee sin que la vista persiga al texto.
        if (text) noteBlock(replyId, "text");
        lastSeqRef.current = seq;
        pendingTurnRef.current = { id: turnId, seq };
        shrinkSpacer();
      },
      onTool: (step, seq) => {
        // Los pasos (tool_use reales) llegan ANTES del primer texto: son lo
        // que reemplaza al "pensando" mudo mientras el agente trabaja. Y si
        // llegan DESPUÉS de un texto, abren un bloque nuevo debajo de él.
        appendStep(replyId, step);
        noteBlock(replyId, "steps");
        lastSeqRef.current = seq;
        pendingTurnRef.current = { id: turnId, seq };
        shrinkSpacer();
      },
      onSession: (sid) => {
        sdkSessionIdRef.current ??= sid;
      },
      // El router avisa qué modelo puso a correr, y VUELVE a avisar si escala
      // (haiku→sonnet→opus) a mitad del turno: el pie lo refleja en vivo.
      onModel: (m) => setModel(m),
      onEnd: (status, seq) => {
        unfollowRef.current = null;
        turnIdRef.current = null;
        lastSeqRef.current = seq;
        pendingTurnRef.current = null;
        setStopping(false);
        setBusy(false);
        // Terminó un turno = se gastó consumo: el pie se entera ya, no en el
        // próximo tick del minuto.
        bumpUsage();
        if (status === "error") {
          void fetchTurn(turnId).then((st) => {
            appendNotice(replyId, st?.error ? `⚠ ${st.error}` : "⚠ el turno falló");
            schedulePersist();
          });
        }
        shrinkSpacer();
        // El hilo queda completo justo aquí: es el guardado que importa (no
        // esperar el debounce de 400ms si justo ahora se cierra la pestaña).
        schedulePersist();
      },
      onDisconnected: (lastSeq) => {
        // Se agotaron los reintentos del navegador; el turno sigue vivo en el
        // servidor. Se guarda el cursor y se intenta reenganchar YA MISMO
        // (mismo mount); si esto también falla, `pendingTurn` queda guardado
        // para que `resumePending` lo recupere al volver de segundo plano.
        unfollowRef.current = null;
        lastSeqRef.current = lastSeq;
        pendingTurnRef.current = { id: turnId, seq: lastSeq };
        schedulePersist();
        resumePendingRef.current();
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

  /**
   * Hueco que queda sobre el mensaje anclado. Antes era un TOP_GAP fijo (12px,
   * pegado al borde) — dejaba la mitad de abajo de la pantalla en blanco
   * cuando la respuesta era corta, y a Samu le resultaba "pantalla muerta".
   * Ahora el ancla se posa a la MITAD del alto visible, no arriba del todo:
   * mismo espíritu (la vista no persigue el stream), pero con contenido
   * arriba Y abajo del punto de lectura.
   */
  const anchorGap = () => {
    const list = listRef.current;
    if (!list) return 12;
    return Math.round(list.clientHeight / 2);
  };

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
    const need = Math.max(0, list.clientHeight - anchorGap() - (content - top));
    if (opts?.shrinkOnly && need > sp.offsetHeight) return;
    sp.style.height = `${need}px`;
  };

  /** Sube el último mensaje del usuario (o bloque de la IA) a la mitad de la lista. */
  const scrollAnchorToTop = () => {
    const list = listRef.current;
    const top = anchorOffset();
    if (!list || top === null) return;
    list.scrollTo({ top: Math.max(0, top - anchorGap()), behavior: "smooth" });
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
   * Visibilidad del botón circular de "ir al final" (sobre el composer).
   * A diferencia de `onUserScroll` (que solo debe reaccionar a gestos
   * directos, ver arriba), este SÍ puede dispararse con `scroll` nativo —
   * incluye nuestros propios `scrollTo`— porque no hace más que reflejar
   * dónde quedó la vista, no decidir si el auto-anclaje sigue activo.
   */
  const onListScrollForJump = () => {
    const list = listRef.current;
    if (!list) return;
    const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
    setShowJumpDown(gap > 200);
  };

  /** Clic en el botón de "ir al final": salta al fondo real y suelta el
   *  anclaje manual, para que el próximo mensaje vuelva a seguirse solo. */
  const jumpToBottom = () => {
    const list = listRef.current;
    if (!list) return;
    userPinnedRef.current = false;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
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
      // El contenido creció por debajo: si Samu está leyendo arriba, el hueco
      // hasta el fondo real también creció, aunque no haya habido scroll.
      onListScrollForJump();
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
      lastSeqRef.current = 0;
      // Se guarda YA, antes de que llegue el primer evento: si la pestaña se
      // cierra en el primer segundo, `resumePending` igual sabe qué turno
      // reenganchar (igual que ChatPanel al arrancar un turno).
      pendingTurnRef.current = { id: turnId, seq: 0 };
      schedulePersist();
      follow(turnId, 0, replyMsg.id);
    } catch (err) {
      turnIdRef.current = null;
      pendingTurnRef.current = null;
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
      pendingTurnRef.current = null;
      unfollowRef.current?.();
      unfollowRef.current = null;
      schedulePersist();
    }
  };

  /**
   * Reengancha el turno que quedó a medias. Se llama al montar y al volver de
   * segundo plano: si el turno terminó mientras no estábamos, se pinta su
   * respuesta completa; si sigue, se sigue en vivo. Es lo que hace que volver
   * al Laboratorio —recargar, o que iOS mate la pestaña en segundo plano y la
   * resucite— muestre la conversación real en vez de un hilo cortado, o peor,
   * un chat en blanco.
   */
  const resumePending = () => {
    const pending = pendingTurnRef.current;
    if (!pending || unfollowRef.current) return; // nada pendiente, o ya enganchado
    // El turno escribe en el ÚLTIMO mensaje del asistente. Si por lo que sea
    // no hay uno (se guardó entre el envío y el placeholder), se crea: sin
    // hueco donde escribir, la respuesta recuperada no se vería.
    const current = messagesRef.current;
    const last = current[current.length - 1];
    let replyId: number;
    if (last?.role === "assistant") {
      replyId = last.id;
    } else {
      replyId = Date.now();
      setMessages((prev) => [...prev, { id: replyId, role: "assistant", content: "", blocks: [] }]);
    }
    turnIdRef.current = pending.id;
    setBusy(true);
    // `fetchTurnResilient` ya reintenta contra blips transitorios (token de
    // Supabase a punto de refrescar, 5xx del agente, red caída un instante).
    // Solo un "not-found" confirmado es pérdida real; `null` significa "no se
    // pudo confirmar nada todavía" y NO debe leerse como "se perdió" — eso es
    // justo lo que obligaba a repetir la pregunta con el turno vivísimo del
    // otro lado.
    void fetchTurnResilient(pending.id, pending.seq).then((st) => {
      if (st === "not-found") {
        // El agente se reinició y el turno ya no existe. Lo honesto es
        // decirlo, no dejar el composer bloqueado para siempre.
        turnIdRef.current = null;
        pendingTurnRef.current = null;
        setBusy(false);
        appendNotice(replyId, "⚠ el turno se perdió al reiniciarse el agente. Vuelve a preguntar.");
        schedulePersist();
        return;
      }
      if (st === null) {
        // Inconclusive tras los reintentos: no se sabe si sigue vivo o no.
        // Se deja todo como estaba (busy, pendingTurn) — más vale reintentar
        // solo cuando vuelva la visibilidad/red que declarar perdido algo que
        // probablemente sigue corriendo. Un reintento acotado por si la
        // pantalla se quedó abierta y visible pero la red seguía inestable.
        if (!resumeRetryPendingRef.current) {
          resumeRetryPendingRef.current = true;
          window.setTimeout(() => {
            resumeRetryPendingRef.current = false;
            resumePendingRef.current();
          }, 8000);
        }
        return;
      }
      // Corriendo o ya cerrado, `follow` resuelve los dos casos: replayea
      // desde `pending.seq` (ni de más ni de menos, ver comentarios en
      // `follow`) y su primer `state` cierra de una si ya había terminado.
      follow(pending.id, pending.seq, replyId);
    });
  };
  resumePendingRef.current = resumePending;

  // Al montar: recuperar lo que quedó corriendo (equivalente a lo que
  // ChatPanel hace al abrir el dashboard). Al desmontar se cierra el stream
  // (no se cancela el turno: sigue vivo en el servidor) para no seguir
  // escribiendo en un componente que ya no está.
  useEffect(() => {
    resumePending();
    return () => unfollowRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al volver del segundo plano: iOS cierra las conexiones de una pestaña
  // congelada sin avisar, así que al recuperar visibilidad (o red) se
  // reengancha.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") resumePendingRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);

  // Persistencia: guarda tras cada cambio visible, agrupado (escribir en cada
  // token del stream sería absurdo). Lo importante es que el turno cerrado se
  // guarde ya — de eso se encargan los `schedulePersist()` explícitos.
  useEffect(() => {
    const t = setTimeout(() => persistNowRef.current(), 400);
    return () => clearTimeout(t);
  }, [messages, draft, model, projKey]);

  // Al irse (cerrar, cambiar de app en iOS) se guarda ya, sin esperar el
  // debounce: "pagehide" es el único evento fiable en Safari móvil.
  useEffect(() => {
    const flush = () => persistNowRef.current();
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  // Cambio de proyecto en foco: guarda el chat activo bajo su clave vieja y
  // restaura el que estaba activo en el proyecto nuevo (el más reciente sin
  // archivar si nunca se guardó cuál era, o uno en blanco si el proyecto no
  // tiene ninguno). El turno en vuelo pertenece al chat VIEJO — se suelta el
  // stream, no se cancela el turno del servidor, y su `pendingTurn` viaja
  // guardado por si se vuelve a ese chat más tarde.
  useEffect(() => {
    if (prevProjRef.current === projKey) return;
    const oldProj = prevProjRef.current;
    chatsRef.current.set(chatStorageKey(oldProj, activeChatIdRef.current), buildThread());
    prevProjRef.current = projKey;

    // Resolver cuál chat retoma el proyecto nuevo: el que recuerde
    // `activeByProject` si sigue vivo y sin archivar, si no el más reciente
    // sin archivar de ese proyecto, si no hay ninguno uno nuevo en blanco.
    const savedId = activeByProjectRef.current[projKey];
    let nextId: string | null = null;
    let nextThread: LabThread | null = null;
    if (savedId) {
      const t = chatsRef.current.get(chatStorageKey(projKey, savedId));
      if (t && !t.archived) {
        nextId = savedId;
        nextThread = t;
      }
    }
    if (!nextThread) {
      for (const [key, t] of chatsRef.current) {
        if (!key.startsWith(`${projKey}::`) || t.archived) continue;
        if (!nextThread || t.updatedAt > nextThread.updatedAt) nextThread = t;
      }
      nextId = nextThread?.id ?? null;
    }
    loadChatIntoState(nextId ?? uuid(), nextThread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projKey]);

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
      {/* Barra superior: antes tenía la flecha de "volver" (quitada el
          2026-08-29 para dejar la pantalla en blanco puro). Vuelve, con el
          icono cambiado por un menú hamburguesa que abre la lista de chats
          del proyecto en foco (varios chats en paralelo, swipe para
          archivar/borrar — ver LabChatsScreen). */}
      <div className="lab-topbar">
        <button
          type="button"
          className="lab-menu-btn"
          aria-label="Ver chats abiertos"
          title="Chats"
          onClick={() => setShowChats(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 6h16M4 12h16M4 18h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {showChats && (
        <LabChatsScreen
          // `chatsVersion` fuerza a recalcular la lista tras crear/archivar/
          // borrar (chatsRef es un ref: mutarlo no dispara un re-render solo).
          key={chatsVersion}
          chats={listChatsForProject(projKey)}
          activeId={activeChatIdRef.current}
          onClose={() => setShowChats(false)}
          onOpen={switchToChat}
          onNew={createNewChat}
          onArchive={archiveChat}
          onUnarchive={unarchiveChat}
          onDelete={deleteChat}
        />
      )}
      <div
        className="lab-messages"
        ref={listRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onScroll={onListScrollForJump}
      >
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
                // Antes eran tres puntos grises saltando; ahora es el orbe en
                // miniatura, ya con ojos (a 56px caben) para que "pensando"
                // se lea como el mismo personaje en todo Hermes (igual que
                // en el arranque). Tamaño = el doble del botón circular de
                // enviar (.lab-send, 28px), o sea 56px.
                <span role="status" aria-label="Hermes está pensando">
                  <OrbeIA tam="56px" ojos ariaLabel="" />
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
        {showJumpDown && (
          <button
            type="button"
            className="lab-jumpdown"
            onClick={jumpToBottom}
            aria-label="Ir al final de la conversación"
            title="Ir al final"
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
              <path d="M12 5v14" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
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
