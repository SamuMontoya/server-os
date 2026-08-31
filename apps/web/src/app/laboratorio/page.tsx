"use client";

// Laboratorio: mismo MOTOR del chat principal (turnos del servidor vía
// apps/agent/src/agent/chat-turns.ts), con el pellejo de Notion en vez del
// HUD. A propósito NO reutiliza el ChatPanel entero (tabs, historial,
// exec bar, voz en tiempo real): esto es el envío/recepción mínimo para
// empezar a vivir acá — el resto (persistencia entre recargas, reenganche
// tras bloquear pantalla, multi-tab) llega en ajustes posteriores.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ChatToolStep } from "@hermes/shared";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import { useWorkspace } from "@/state/WorkspaceContext";
import { startTurn, attachTurn, fetchTurn } from "@/lib/chat-turns";
import { Markdown } from "@/components/Markdown";
import { AgentSteps } from "@/components/AgentSteps";
import { LabStatusBar } from "@/components/LabStatusBar";
import { uuid } from "@/lib/uuid";
import { isSupportedImage, uploadChatImage } from "@/lib/chat-attachments";

type LabMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Pasos de herramientas del turno (solo en mensajes del asistente):
   *  los tool_use REALES que el SDK reportó mientras generaba esta
   *  respuesta — leer archivos, correr comandos, buscar en la memoria, etc. */
  steps?: ChatToolStep[];
  /** Imágenes que iban con el mensaje (solo en mensajes del usuario): quedan
   *  visibles en la burbuja, como el adjunto que fueron. */
  images?: { url: string; name: string }[];
};

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
  // Imágenes pegadas que todavía no se han enviado.
  const [attachments, setAttachments] = useState<LabAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  // Al montar, con el draft vacío, fija el alto real de una línea en vez de
  // dejar el alto por defecto del navegador (más alto → placeholder pegado
  // arriba con hueco debajo, ver .lab-textarea en globals.css).
  useEffect(() => {
    resizeInput();
  }, []);

  // Escribe/acumula en el mensaje de respuesta por id — igual patrón que
  // `writeReply` en ChatPanel, pero sobre el array plano de esta página.
  const writeReply = (replyId: number, fn: (prev: string) => string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === replyId ? { ...m, content: fn(m.content) } : m)),
    );
  };
  const writeSteps = (replyId: number, fn: (prev: ChatToolStep[]) => ChatToolStep[]) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === replyId ? { ...m, steps: fn(m.steps ?? []) } : m)),
    );
  };

  // Engancha el stream del turno y va pintando la respuesta a medida que
  // llega. Es la versión mínima de `follow()` en ChatPanel: sin pasos de
  // herramientas ni reenganche tras perder la pestaña — eso llega después.
  const follow = (turnId: string, from: number, replyId: number) => {
    unfollowRef.current?.();
    const close = attachTurn(turnId, from, {
      onState: (st) => {
        if (st.text) writeReply(replyId, () => st.text);
        // El snapshot trae la lista COMPLETA de pasos hasta ahora (verdad del
        // servidor, no un delta): se reemplaza entero, igual que el texto.
        if (st.steps.length > 0) writeSteps(replyId, () => st.steps);
        setBusy(st.status === "running");
        // El snapshot ya trae el modelo elegido: al reengancharse a un turno
        // en curso el pie no queda en "—" esperando el próximo evento.
        if (st.model) setModel(st.model);
        if (st.sdkSessionId) sdkSessionIdRef.current ??= st.sdkSessionId;
        scrollToBottom();
      },
      onDelta: (text) => {
        writeReply(replyId, (prev) => prev + text);
        scrollToBottom();
      },
      onTool: (step) => {
        // Los pasos (tool_use reales) llegan ANTES del primer texto: son lo
        // que reemplaza al "pensando" mudo mientras el agente trabaja.
        writeSteps(replyId, (prev) => [...prev, step]);
        scrollToBottom();
      },
      onSession: (sid) => {
        sdkSessionIdRef.current ??= sid;
      },
      // El router avisa qué modelo puso a correr, y VUELVE a avisar si escala
      // (haiku→sonnet→opus) a mitad del turno: el pie lo refleja en vivo.
      onModel: (m) => setModel(m),
      onEnd: (status) => {
        unfollowRef.current = null;
        setBusy(false);
        if (status === "error") {
          void fetchTurn(turnId).then((st) => {
            const detail = st?.error ? `⚠ ${st.error}` : "⚠ el turno falló";
            writeReply(replyId, (prev) => (prev.trim() ? `${prev}\n\n${detail}` : detail));
          });
        }
        scrollToBottom();
      },
      onDisconnected: () => {
        // Se agotaron los reintentos del navegador; el turno puede seguir
        // vivo en el servidor. De momento se avisa y ya — reengancharse
        // solo al volver es uno de los "ajustes posteriores" pendientes.
        setBusy(false);
        writeReply(replyId, (prev) =>
          prev.trim() ? prev : "⚠ se perdió la conexión con Hermes.",
        );
      },
    });
    unfollowRef.current = close;
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ block: "end" }));
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
    if (listening) micStop();

    const sent = attachments.filter((a) => a.id);
    const userMsg: LabMessage = {
      id: Date.now(),
      role: "user",
      content: text,
      ...(sent.length ? { images: sent.map((a) => ({ url: a.url, name: a.name })) } : {}),
    };
    const replyMsg: LabMessage = { id: Date.now() + 1, role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, replyMsg]);
    setDraft("");
    // Se vacía el composer SIN revocar los object URLs: los hereda la burbuja,
    // que los sigue pintando. Se sueltan todos al desmontar la página.
    setAttachments([]);
    setBusy(true);
    // El textarea no se re-mide solo al vaciar el value por JS (no dispara
    // onChange); lo hacemos a mano en el próximo frame, cuando el DOM ya
    // tiene el value nuevo.
    requestAnimationFrame(resizeInput);
    scrollToBottom();

    try {
      const turnId = await startTurn({
        message: text,
        sessionKey: sessionKeyRef.current!,
        project: selectedProject,
        resume: sdkSessionIdRef.current,
        attachments: sent.map((a) => a.id!),
      });
      follow(turnId, 0, replyMsg.id);
    } catch (err) {
      setBusy(false);
      const detail = err instanceof Error ? err.message : "no se pudo enviar el mensaje";
      writeReply(replyMsg.id, () => `⚠ ${detail}`);
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
      const base = dictationBaseRef.current;
      const sep = base && !base.endsWith(" ") ? " " : "";
      setDraft(base + sep + text);
      // En el frame siguiente, NO ahora: `setDraft` aún no ha llegado al DOM,
      // así que medir aquí daba el alto del texto anterior (el textarea iba
      // siempre una línea por detrás al dictar).
      requestAnimationFrame(resizeInput);
    },
  });

  const toggleMic = () => {
    if (listening) {
      micStop();
      return;
    }
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
      <Link href="/" className="lab-back" title="Volver" aria-label="Volver">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M15 5 8 12l7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>

      <div className="lab-messages">
        {messages.map((m, idx) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="lab-bubble">
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
          const steps = m.steps ?? [];
          // Solo el ÚLTIMO mensaje puede estar en curso: es donde escribe el
          // turno activo (busy es global porque solo corre un turno a la vez).
          const streaming = busy && idx === messages.length - 1;
          return (
            <div key={m.id} className="lab-answer">
              {/* Pasos ANTES del texto (patrón Replit): el trabajo se ve
                  mientras ocurre, la respuesta aterriza debajo. El wrapper
                  .lab-steps repinta los acentos violeta/ámbar del HUD oscuro
                  a la paleta clara de Notion — ver globals.css. */}
              {steps.length > 0 && (
                <div className="lab-steps">
                  <AgentSteps steps={steps} busy={streaming} />
                </div>
              )}
              {m.content ? (
                <Markdown source={m.content} project={selectedProject ?? undefined} />
              ) : streaming && steps.length === 0 ? (
                // "Pensando" solo hasta el primer paso: a partir de ahí los
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
        <div ref={messagesEndRef} />
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
        <LabStatusBar model={model} />
      </div>
    </main>
  );
}
