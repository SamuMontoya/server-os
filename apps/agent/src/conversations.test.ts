/**
 * Solo cubre la regla de dueño de un mensaje (`messageVisibleTo`) — el resto
 * de conversations.ts es I/O de disco sin tests hasta ahora; no se amplía
 * ese alcance acá.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { messageVisibleTo, type StoredMessage } from "./conversations.js";

const msgDe = (userId?: string): StoredMessage => ({
  role: "user",
  content: "hola",
  ts: "2026-01-01T00:00:00.000Z",
  ...(userId ? { userId } : {}),
});

test("messageVisibleTo: solo choca cuando AMBOS lados tienen userId y no coinciden", () => {
  // Mensaje sin dueño (historial viejo, o key estática): visible para todos.
  assert.equal(messageVisibleTo(msgDe(undefined), "user-a"), true);
  assert.equal(messageVisibleTo(msgDe(undefined), undefined), true);
  // Requester sin userId (key estática): full trust, ve cualquier mensaje.
  assert.equal(messageVisibleTo(msgDe("user-a"), undefined), true);
  // Mismo dueño: visible.
  assert.equal(messageVisibleTo(msgDe("user-a"), "user-a"), true);
  // Dueños distintos: el único caso que se niega.
  assert.equal(messageVisibleTo(msgDe("user-a"), "user-b"), false);
});
