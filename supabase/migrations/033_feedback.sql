-- Buzón de mejoras (pedido de Jaime 2026-09-30): CENTRALIZADO — cualquier
-- usuario con acceso al portal ve y puede mover de estado CUALQUIER reporte,
-- no solo el que creó (a diferencia de chat_threads, que es privado por
-- user_id). El backend pega con la service-role key (bypassea RLS del todo,
-- ver apps/agent/src/supabase.ts), así que la barrera REAL vive en
-- apps/agent/src/routes/feedback.ts (userId en sesión + email para
-- "completado") — estas políticas son defensa en profundidad por si algún
-- día algo pega con la anon key.
CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  priority integer NOT NULL DEFAULT 2 CHECK (priority IN (1, 2, 3)),
  status text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'en_revision', 'completado')),
  images jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Lectura y cambio de estado: cualquier usuario autenticado, no solo el
-- dueño de la fila — es un tablero compartido.
CREATE POLICY "Authenticated users can view all feedback"
  ON feedback FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can create feedback"
  ON feedback FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Authenticated users can update any feedback"
  ON feedback FOR UPDATE USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
-- Borrar SÍ queda restringido al creador (única acción destructiva del
-- buzón) — ver el comentario de deleteFeedback() en feedback.ts.
CREATE POLICY "Users can delete their own feedback"
  ON feedback FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_feedback_project_status ON feedback(project, status);
CREATE INDEX idx_feedback_created_at_desc ON feedback(created_at DESC);
CREATE INDEX idx_feedback_completed_at ON feedback(completed_at) WHERE status = 'completado';

CREATE OR REPLACE FUNCTION update_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feedback_updated_at_trigger
BEFORE UPDATE ON feedback FOR EACH ROW EXECUTE FUNCTION update_feedback_updated_at();

CREATE TABLE IF NOT EXISTS feedback_audit (
  id bigserial PRIMARY KEY,
  feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  action text NOT NULL,
  old_status text, new_status text,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_feedback_audit_feedback_id ON feedback_audit(feedback_id);
CREATE INDEX idx_feedback_audit_changed_at ON feedback_audit(changed_at DESC);
