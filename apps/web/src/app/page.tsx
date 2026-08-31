import { redirect } from "next/navigation";

/**
 * La raíz abre el LABORATORIO.
 *
 * Antes "/" era el dashboard (vista ORQUESTADOR) y el Laboratorio quedaba a un
 * clic del rail. Se invirtió: abrir la app —icono del iPhone, pestaña nueva,
 * atajo— tiene que dejar el chat delante, sin pasos intermedios. El dashboard
 * no desapareció: vive en "/os" (app/os/page.tsx) y sigue a un toque desde la
 * flecha de volver del Laboratorio y desde el rail.
 *
 * Es un redirect de SERVIDOR, no un `useEffect` con `router.push`: así no se
 * llega a montar el árbol del dashboard (polls, SSE, providers) para tirarlo un
 * frame después, y no hay parpadeo al entrar.
 */
export default function Home() {
  redirect("/laboratorio");
}
