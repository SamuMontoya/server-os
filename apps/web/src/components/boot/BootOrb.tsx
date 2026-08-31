"use client";

// Pantalla de arranque de Hermes OS — versión orbe.
//
// Reemplaza al HUD oscuro de BootLoader.tsx (grafo de nodos + barra + %) por
// el Orbe IA centrado sobre fondo blanco: Samu pidió que en vez del porcentaje
// de carga saliera el orbe. BootLoader.tsx queda en el repo sin usar por si
// hay que volver atrás; BootGate.tsx es el único punto que decide cuál de los
// dos se monta.
//
// El CONTRATO con BootGate no cambia (progress/finish/labels/onDone): `labels`
// ya no se usa (era para los nombres de proyecto del grafo), se deja en la
// firma para no tener que tocar BootGate.

import { useEffect, useRef, useState } from "react";
import { OrbeIA } from "@/components/orbe/OrbeIA";

interface BootOrbProps {
  /** Progreso real de carga 0..100. Solo se anuncia por accesibilidad: la
   *  pantalla en sí no dibuja número ni barra (eso es lo que se quitó). */
  progress: number;
  /** Al pasar a true: hace fade y llama onDone tras la transición. */
  finish: boolean;
  /** Sin uso aquí (existía para los labels del grafo de BootLoader). */
  labels?: string[];
  /** Se llama tras el fade-out para desmontar el overlay. */
  onDone: () => void;
}

const FADE_MS = 450;

export function BootOrb({ progress, finish, onDone }: BootOrbProps) {
  const [saliendo, setSaliendo] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!finish) return;
    setSaliendo(true);
    const t = window.setTimeout(() => onDoneRef.current(), FADE_MS);
    return () => window.clearTimeout(t);
  }, [finish]);

  const pct = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <div
      aria-label="Arranque de Hermes OS"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        background: "#fff",
        display: "grid",
        placeItems: "center",
        opacity: saliendo ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: saliendo ? "none" : "auto",
      }}
    >
      <OrbeIA tam="min(38vmin, 220px)" ariaLabel="Hermes está arrancando" />
      {/* Progreso real, solo para lectores de pantalla: la pantalla visible
          es nada más el orbe, sin número ni barra. */}
      <span
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {`Cargando Hermes, ${pct}%`}
      </span>
    </div>
  );
}
