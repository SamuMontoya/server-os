import type { Metadata, Viewport } from "next";
import { Chakra_Petch, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Las vars se llaman --font-chakra/--font-plex (no --font-display/--font-mono)
// porque el @theme de globals.css define estas últimas referenciándolas —
// si compartieran nombre habría una referencia circular.
const display = Chakra_Petch({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-chakra",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-plex",
});

export const metadata: Metadata = {
  title: "HERMES OS",
  description: "AI Operating System personal de RuloCode",
  // Instalado en la pantalla de inicio del iPhone, el dashboard se abre en
  // modo app (sin barra de Safari). `appleWebApp` es lo que iOS mira: sin él
  // queda como un marcador y se comporta como una pestaña más.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Hermes" },
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/** El notch/isla y la barra de estado pintadas con el fondo de la app. */
export const viewport: Viewport = {
  themeColor: "#05060f",
  // El dashboard maneja su propio scroll; el zoom por pinza en móvil rompe el
  // layout de la consola y no aporta nada aquí.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${display.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
