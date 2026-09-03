"use client";

// Topbar: UNA línea. Las métricas son texto inline, no paneles.
//
// Antes CPU/RAM/DISCO tenían un panel con título y barras, y Claude Usage un
// gauge radial + 5 modelos + sparkline — para 8 ejecuciones históricas. Aquí
// siguen visibles pero dejan de competir con la consola: dato crudo + micro-barra.
//
// Regla de oro: dato real o nada. Cada pieza se omite si su fuente no responde.

import { useDashboard } from "@/state/DashboardProvider";
import { useHermesData } from "@/hooks/useHermesData";
import { useWorkspace } from "@/state/WorkspaceContext";
import { Clock } from "@/components/Clock";
import { SpeakToggle } from "./SpeakToggle";
// El selector solo tiene sentido si el dashboard puede apuntar a otro agente.
// Con NEXT_PUBLIC_HERMES_PIN_AGENT=1 la condición es un literal inlineado y
// webpack se lleva el componente entero del bundle.
import { MachineSelector } from "@/components/MachineSelector";

function Vital({ label, pct }: { label: string; pct: number }) {
  const warn = pct >= 90;
  return (
    <div className="flex items-center gap-1.5 text-2xs text-text-faint">
      <span>{label}</span>
      <span className="h-0.5 w-6.5 overflow-hidden rounded-xs bg-violet/16">
        <span
          className={`block h-full ${warn ? "bg-amber" : "bg-violet/75"}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <b className={`font-normal ${warn ? "text-amber" : "text-text-dim"}`}>{Math.round(pct)}%</b>
    </div>
  );
}

export function TopBar() {
  const { snapshot } = useDashboard();
  const { online } = useHermesData();
  const ws = useWorkspace();
  const sys = snapshot?.system;

  return (
    <header className="flex h-13 shrink-0 items-center justify-between border-b border-line px-5">
      <div className="flex items-center gap-3">
        <h1 className="text-xs font-semibold tracking-hero uppercase">
          <span className="text-violet">OS</span>
        </h1>
        <span className="flex items-center gap-1.5 text-2xs tracking-label text-text-dim uppercase">
          <span
            className={`h-1.5 w-1.5 rounded-full ${online ? "bg-green shadow-[0_0_8px_var(--color-green)]" : "bg-red"}`}
          />
          {online ? "En línea" : "Desconectado"}
        </span>
        <SpeakToggle />
      </div>

      <div className="flex items-center gap-5">
        {sys && (
          <div className="hidden items-center gap-5 lg:flex">
            <Vital label="CPU" pct={sys.cpuPct} />
            <Vital label="RAM" pct={sys.memUsedPct} />
            <Vital label="SSD" pct={sys.diskUsedPct} />
          </div>
        )}
        {process.env.NEXT_PUBLIC_HERMES_PIN_AGENT !== "1" && <MachineSelector />}
        <button
          type="button"
          onClick={() => ws.setPaletteOpen(true)}
          title="Paleta de comandos (⌘K)"
          className="hidden cursor-pointer items-center gap-1.5 rounded-sm border border-line px-2 py-1 text-2xs tracking-label text-text-faint uppercase transition-colors hover:border-line-2 hover:text-text-dim md:flex"
        >
          <span>Buscar</span>
          <span className="text-violet">⌘K</span>
        </button>
        <Clock />
      </div>
    </header>
  );
}
