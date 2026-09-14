"use client";

import { createClient } from "@/lib/supabase/client";

/**
 * Access token de la sesión, disponible de forma SÍNCRONA.
 *
 * El dashboard manda su credencial al agente desde funciones síncronas
 * (`hermesFetch`, y sobre todo `sseUrl`, que arma una URL para EventSource).
 * Pedirle el token a Supabase es asíncrono, así que volverlas async
 * obligaría a tocar decenas de llamadas y a convertir en promesa una función
 * que solo devuelve un string.
 *
 * En vez de eso se cachea aquí: Supabase avisa de cada cambio de sesión —
 * incluido el refresco automático del token, que ocurre solo — y este módulo
 * mantiene el valor al día. Quien lo lee siempre ve el token vigente.
 *
 * Por qué importa: hasta ahora el navegador mandaba la HERMES_API_KEY, que va
 * INCRUSTADA en el bundle — cualquiera que cargue la página se la lleva, y
 * revocarla obliga a rotarla en todas las máquinas. Con el JWT, cada petición
 * queda atada a una identidad y quitar el acceso es quitar el usuario.
 */

let accessToken: string | null = null;
let iniciado = false;

/** Token vigente, o null si no hay sesión. Síncrono a propósito. */
export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Se resuelve cuando la hidratación INICIAL del token termina (haya sesión o
 * no) — una sola vez, no en cada refresco posterior. Sirve para lo que SÍ
 * necesita esperar identidad antes de disparar (ver `waitForInitialSession`);
 * el resto del código sigue leyendo `getAccessToken()` síncrono como siempre.
 */
let resolveInitialSession: (() => void) | null = null;
const initialSessionPromise = new Promise<void>((resolve) => {
  resolveInitialSession = resolve;
});

/**
 * Espera a que la sesión inicial de Supabase termine de hidratarse.
 *
 * Por qué existe: `getAccessToken()` es síncrono a propósito (ver arriba),
 * pero eso significa que justo después de montar la app SIEMPRE devuelve
 * `null` durante los primeros milisegundos — `getSession()` es async y
 * `providers.tsx` no espera a que resuelva antes de renderizar los hijos.
 * En una red rápida (LAN, sesión ya tibia) esa ventana es tan corta que
 * nunca se nota; en un arranque frío de iPad (Wi-Fi lenta, PWA recién
 * abierta) es lo bastante larga como para que algo que dispara EN EL MISMO
 * TICK del montaje (como el sync de chats de /laboratorio) salga con
 * `getHermesKey()` cayendo a la key estática de LAN — sin userId, el
 * servidor responde "no hay nada guardado" aunque la cuenta sí tenga
 * historial. No es que no cargó: es que preguntó antes de saber quién era.
 * Cualquier llamada que dependa de IDENTIDAD (no solo de tener *algún*
 * bearer) debe esperar esto antes de la primera petición.
 */
export function waitForInitialSession(): Promise<void> {
  return initialSessionPromise;
}

/**
 * Arranca la suscripción. Idempotente: se llama desde el árbol de providers y
 * un doble montaje (StrictMode) no debe abrir dos suscripciones.
 */
export function iniciarTokenSync(): void {
  if (iniciado || typeof window === "undefined") return;
  iniciado = true;

  const supabase = createClient();

  // La sesión inicial no llega por el evento si ya existía al cargar.
  void supabase.auth.getSession().then(({ data }) => {
    accessToken = data.session?.access_token ?? accessToken;
    resolveInitialSession?.();
    resolveInitialSession = null;
  });

  supabase.auth.onAuthStateChange((_evento, session) => {
    // Cubre login, logout Y el refresco automático: sin escuchar aquí, el
    // token cacheado caducaría en ~1 h y las peticiones empezarían a dar 401
    // sin que nada más cambiara.
    accessToken = session?.access_token ?? null;
  });
}
