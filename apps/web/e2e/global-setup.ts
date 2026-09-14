import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

/**
 * Autentica una sesión real de Supabase para los tests e2e sin pasar por el
 * botón de Google: usa la service_role key (propia del repo, en .env) para
 * generar un magic link server-side, lo canjea contra `/auth/v1/verify` y
 * arma la cookie de sesión con la MISMA serialización que usa @supabase/ssr
 * en producción (createServerClient + setSession), en vez de adivinar a mano
 * el formato de chunking/base64url — así si la librería cambia de formato,
 * el setup se rompe ruidosamente en vez de fabricar una cookie que el
 * middleware real no sabría leer.
 *
 * El correo tiene que estar en NEXT_PUBLIC_HERMES_ALLOWED_EMAILS (si no, el
 * middleware cierra la sesión y redirige a /login?error=denegado).
 */

const EMAIL_TEST = "jtautiva@gmail.com";

function cargarEnvRaiz(): void {
  // apps/web no tiene su propio .env; el server real lo levanta con el de la
  // raíz del monorepo. Se parsea a mano (KEY=VALUE) para no sumar una
  // dependencia nueva solo para este script de setup.
  const ruta = path.join(__dirname, "..", "..", "..", ".env");
  if (!fs.existsSync(ruta)) return;
  for (const linea of fs.readFileSync(ruta, "utf8").split("\n")) {
    const l = linea.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i === -1) continue;
    const clave = l.slice(0, i).trim();
    let valor = l.slice(i + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (!(clave in process.env)) process.env[clave] = valor;
  }
}

export default async function globalSetup(): Promise<void> {
  cargarEnvRaiz();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !serviceRole) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY para autenticar los tests e2e",
    );
  }

  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL_TEST,
  });
  if (linkError || !linkData) {
    throw new Error(`generateLink falló para ${EMAIL_TEST}: ${linkError?.message}`);
  }
  const hashedToken = linkData.properties?.hashed_token;
  if (!hashedToken) throw new Error("generateLink no devolvió properties.hashed_token");

  // El endpoint espera `token_hash` (no `token`) y type:"email" para
  // verificar por hash de token — "magiclink" es el tipo del LINK generado,
  // pero al canjearlo por hash el tipo de verificación es "email" (ver
  // GoTrueClient.verifyOtp: `{ token_hash: tokenHash, type: 'email' }`).
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon },
    body: JSON.stringify({ type: "email", token_hash: hashedToken }),
  });
  if (!verifyRes.ok) {
    throw new Error(`/auth/v1/verify (${verifyRes.status}): ${await verifyRes.text()}`);
  }
  const sesion = (await verifyRes.json()) as { access_token: string; refresh_token: string };
  if (!sesion.access_token || !sesion.refresh_token) {
    throw new Error(`/auth/v1/verify no devolvió tokens: ${JSON.stringify(sesion)}`);
  }

  type CookieAPuntar = {
    name: string;
    value: string;
    options?: { path?: string; maxAge?: number; sameSite?: string | boolean; secure?: boolean };
  };
  const cookiesCapturadas: CookieAPuntar[] = [];
  const serverClient = createServerClient(url, anon, {
    cookies: {
      getAll: () => [],
      setAll: (cookiesToSet) => {
        for (const c of cookiesToSet) cookiesCapturadas.push(c as CookieAPuntar);
      },
    },
  });
  const { error: setErr } = await serverClient.auth.setSession({
    access_token: sesion.access_token,
    refresh_token: sesion.refresh_token,
  });
  if (setErr) throw new Error(`setSession falló: ${setErr.message}`);
  // onAuthStateChange (donde @supabase/ssr realmente escribe las cookies)
  // corre en un microtask aparte; se le da una vuelta de reloj.
  await new Promise((r) => setTimeout(r, 100));

  if (cookiesCapturadas.length === 0) {
    throw new Error(
      "setSession no disparó ninguna cookie — revisa si @supabase/ssr cambió su mecanismo interno (createServerClient.js)",
    );
  }

  const storageState = {
    cookies: cookiesCapturadas.map((c) => ({
      name: c.name,
      value: c.value,
      domain: "localhost",
      path: c.options?.path ?? "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
      expires: Math.floor(Date.now() / 1000) + (c.options?.maxAge ?? 60 * 60 * 24),
    })),
    origins: [],
  };

  const dir = path.join(__dirname, ".auth");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(storageState, null, 2));
}
