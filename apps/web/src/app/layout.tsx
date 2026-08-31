import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "./providers";

// Fuentes AUTO-HOSPEDADAS (antes venían de next/font/google).
// `next/font/google` descarga los woff2 de fonts.gstatic.com en CADA build. Con
// la conexión intermitente de esta máquina, cuando la descarga falla Next entra
// en un bucle "Retrying 1/3..." que deja el build colgado hasta el timeout: era
// la causa real de los builds "Failed" y de los que se quedaban pensando 15 min.
// Los .woff2 viven ahora en ./fonts (subset latin, los mismos pesos de antes),
// así que el build ya no toca la red. Para actualizarlos, o si cambias los
// pesos de aquí abajo:  node scripts/fetch-fonts.mjs
//
// Las vars se llaman --font-chakra/--font-plex (no --font-display/--font-mono)
// porque el @theme de globals.css define estas últimas referenciándolas —
// si compartieran nombre habría una referencia circular.
const display = localFont({
  src: [
    { path: "./fonts/chakra-petch-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/chakra-petch-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/chakra-petch-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-chakra",
  display: "swap",
});

const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-mono-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: "HERMES OS",
  description: "AI Operating System personal de RuloCode",
  // Instalado en la pantalla de inicio del iPhone, el dashboard se abre en
  // modo app (sin barra de Safari). `appleWebApp` es lo que iOS mira: sin él
  // queda como un marcador y se comporta como una pestaña más.
  // "black-translucent" dejaba la barra de estado (hora, batería,
  // notificaciones) TRANSPARENTE, con el contenido de la app dibujándose por
  // detrás — el padding-top con safe-area-inset-top en SideRail ayudaba pero
  // no garantizaba nada porque seguía siendo el mismo lienzo. "black" la
  // vuelve opaca de verdad: iOS reserva ese espacio como una franja negra
  // sólida y el layout viewport arranca abajo de ella, así que ningún
  // ícono ni texto puede quedar por detrás nunca, pase lo que pase con el
  // contenido de la página.
  appleWebApp: { capable: true, statusBarStyle: "black", title: "Hermes" },
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// Sin esto, Next emite `width=device-width, initial-scale=1` a secas, y el
// navegador usa el default `interactive-widget=resizes-visual`: al abrir el
// teclado el layout viewport NO se encoge, solo se desplaza la vista. Los
// elementos `position: fixed` siguen anclados al viewport completo, así que la
// barra de input queda por debajo del teclado y hay que scrollear a mano para
// verla (y en el hueco asoma el fondo oscuro del documento).
// `resizes-content` hace que el teclado encoja el layout viewport de verdad:
// 100dvh, los fixed y todo el layout se recalculan solos. Es lo que convierte
// el ajuste en automático en vez de depender del scroll del usuario.
// Safari iOS aún lo ignora — para ese caso queda el fallback de
// visualViewport en /laboratorio.
// `themeColor` pinta la barra de estado con el fondo de la app y `viewportFit`
// deja el contenido llegar bajo el notch cuando corre como app instalada.
export const viewport: Viewport = {
  themeColor: "#05060f",
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${display.variable} ${mono.variable}`}>
      <body>
        {/* Blackout permanente del área de la barra de estado (hora, batería,
            notificaciones, notch). No es solo el padding-top de SideRail: es
            una franja propia, fija y opaca, encima de TODO (z-index más alto
            que overlays/toasts), así que aunque algo del contenido cambie
            nunca vuelve a asomarse por detrás de la barra. Blanca en
            /laboratorio, oscura en el resto — mismo criterio que ya usa
            html.lab-route para el fondo. */}
        <div aria-hidden className="safe-top-blackout" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
