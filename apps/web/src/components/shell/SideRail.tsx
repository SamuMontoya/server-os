"use client";

// Rail de iconos: la navegación deja de gritar.
//
// Reemplaza al header con NavTabs (3 rutas) + la TabBar de 7 tabs en mayúsculas
// que competían con la consola. Aquí el destino activo se marca con LUZ, no con
// una caja, y las etiquetas viven en tooltips: el rail cuesta 60px y devuelve
// ~200px de ancho al contenido.
//
// Mezcla rutas (Orquestador · Vida · Agenda) y tabs del workspace (Tareas,
// Reuniones, Memoria) en una sola lista porque para quien lo usa son lo mismo:
// "a dónde voy". La distinción ruta/tab es un detalle de implementación.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWorkspace, type CenterTab } from "@/state/WorkspaceContext";

type Dest =
  | { kind: "route"; href: string; label: string; icon: React.ReactNode }
  | { kind: "tab"; tab: CenterTab; label: string; icon: React.ReactNode };

const I = (d: string, extra?: React.ReactNode) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    {extra}
  </svg>
);

const DESTS: Dest[] = [
  {
    kind: "route",
    // El dashboard se mudó a /os (la raíz abre el Laboratorio, ver app/page.tsx).
    href: "/os",
    label: "Orquestador",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <circle cx="12" cy="12" r="9" opacity=".45" />
      </svg>
    ),
  },
  {
    kind: "tab",
    tab: "memoria",
    label: "Memoria",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="2.4" />
        <circle cx="5" cy="7" r="1.7" />
        <circle cx="19" cy="8" r="1.7" />
        <circle cx="7" cy="18" r="1.7" />
        <path d="M10 11 6.4 8.2M14 11.4 17.4 9.3M11 14.2 8.2 16.6" opacity=".5" />
      </svg>
    ),
  },
  // Chat: la conversación principal, pantalla propia fuera del shell.
  {
    kind: "route",
    href: "/laboratorio",
    label: "Chat",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9 4.5a2.5 2.5 0 0 0-2.5 2.5c0 .3.03.6.1.88A2.5 2.5 0 0 0 5 10.2v1.1a2.5 2.5 0 0 0 .8 4.6c.15 1.4 1.35 2.5 2.8 2.5.4 0 .78-.08 1.13-.23A2 2 0 0 0 11.5 20V6.5A2 2 0 0 0 9 4.5Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15 4.5a2.5 2.5 0 0 1 2.5 2.5c0 .3-.03.6-.1.88A2.5 2.5 0 0 1 19 10.2v1.1a2.5 2.5 0 0 1-.8 4.6c-.15 1.4-1.35 2.5-2.8 2.5-.4 0-.78-.08-1.13-.23A2 2 0 0 1 12.5 20V6.5A2 2 0 0 1 15 4.5Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function SideRail() {
  const pathname = usePathname();
  const ws = useWorkspace();
  const inHome = pathname === "/os" || pathname === "/";

  return (
    <nav
      aria-label="Navegación"
      className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-line pb-4"
      style={{ paddingTop: "calc(16px + env(safe-area-inset-top))" }}
    >
      <Link
        href="/laboratorio"
        title="Chat"
        className="mb-5 grid h-6.5 w-6.5 place-items-center drop-shadow-[0_0_7px_rgb(167_139_250_/_0.55)] transition-transform hover:scale-110"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M12 2 21.5 7v10L12 22 2.5 17V7z" stroke="currentColor" strokeWidth="1.2" className="text-violet" fill="rgb(167 139 250 / 0.09)" />
          <circle cx="12" cy="12" r="3.1" className="fill-violet-hot" />
        </svg>
      </Link>

      <div className="flex flex-1 flex-col gap-1">
        {DESTS.map((d) => {
          const active =
            d.kind === "route"
              ? d.kind === "route" && pathname === d.href && (d.href !== "/" || ws.tab === "consola")
              : inHome && ws.tab === d.tab;

          const cls = `group relative grid h-9.5 w-9.5 cursor-pointer place-items-center rounded-sm transition-colors ${
            active ? "bg-violet/9 text-violet" : "text-text-faint hover:bg-violet/5 hover:text-text-dim"
          }`;

          const inner = (
            <>
              {d.icon}
              {/* El activo se marca con luz, no con una caja */}
              {active && (
                <span aria-hidden className="absolute -left-2.5 h-4 w-0.5 rounded-xs bg-violet shadow-[0_0_10px_var(--color-violet)]" />
              )}
              <span className="pointer-events-none absolute left-11 z-40 -translate-x-1 rounded-sm border border-line bg-panel-2 px-2 py-1 text-2xs tracking-label whitespace-nowrap text-text-dim uppercase opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100">
                {d.label}
              </span>
            </>
          );

          return d.kind === "route" ? (
            <Link key={d.href} href={d.href} className={cls} aria-current={active ? "page" : undefined} title={d.label}>
              {inner}
            </Link>
          ) : (
            <button key={d.tab} type="button" onClick={() => ws.showPanel(d.tab)} className={cls} title={d.label}>
              {inner}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
