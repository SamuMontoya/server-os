-- Añade el dueño del turno al checkpoint, para que sobreviva a un reinicio.
--
-- chat-turns.ts ahora guarda `userId` en cada ChatTurn (resuelto del JWT de
-- Supabase por el middleware, ver auth.ts) y lo usa para que un usuario no
-- pueda leer ni cancelar el turno de otro. Sin esta columna, un turno de un
-- usuario con JWT que muere a mitad de camino (deploy, OOM) se recuperaba en
-- `reconcileChatTurns()` como un mensaje SIN dueño — visible para cualquiera,
-- justo el hueco que el resto del cambio cierra. Nullable: turnos sin `userId`
-- (HERMES_API_KEY estática, reloj) siguen sin dueño, como siempre.
alter table chat_turn_checkpoints add column if not exists user_id text;
