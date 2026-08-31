/**
 * Imágenes pegadas en el input del chat.
 *
 * El flujo es "subir al pegar, enviar por id":
 *   1. pegas (o suetas) una imagen → se sube YA a /chat/attachments
 *   2. el composer muestra el chip con la miniatura mientras escribes
 *   3. al enviar, el turno lleva solo los ids
 *
 * Subir en el momento del pegado y no en el del envío es lo que hace que el
 * chip aparezca instantáneo y que darle Enter no se quede colgado esperando a
 * que viaje un pantallazo de 3 MB.
 */
import { hermesFetch } from "@/lib/hermes";

/** Lo que devuelve el servidor tras guardar (sin la ruta en disco). */
export interface ChatAttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Debe coincidir con IMAGE_TYPES en apps/agent/src/chat-attachments.ts. */
const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];

export function isSupportedImage(type: string): boolean {
  return ACCEPTED.includes(type.toLowerCase().split(";")[0].trim());
}

export async function uploadChatImage(file: File | Blob, name = "captura.png"): Promise<ChatAttachmentMeta> {
  const form = new FormData();
  // Sin Content-Type a mano: el browser pone el boundary del multipart.
  // hermesFetch solo inyecta el Bearer.
  form.append("image", file, file instanceof File ? file.name : name);
  const res = await hermesFetch("/chat/attachments", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as ChatAttachmentMeta & { error?: string };
  if (!res.ok || !data.id) throw new Error(data.error || `no se pudo subir la imagen (${res.status})`);
  return data;
}

// Nota sobre las miniaturas: NO se piden al servidor. El archivo ya está en el
// navegador cuando lo pegas, así que la preview sale de un
// `URL.createObjectURL(file)` local y aparece instantánea, sin round-trip. El
// endpoint `GET /chat/attachments/:id` existe del otro lado para cuando el
// Laboratorio persista mensajes entre recargas (ahí ya no habrá File local);
// pide Bearer, así que en ese momento habrá que descargarlo con `hermesFetch`
// y envolverlo en un object URL — un <img src> pelado no manda headers.
