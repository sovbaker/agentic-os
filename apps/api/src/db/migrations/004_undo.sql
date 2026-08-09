-- Отмена действия должна быть исполнимой, а не просто отмеченной как
-- «обратимая». Для этого рядом с записью журнала хранится то, чем именно
-- её откатывать: инструмент, аргументы и мини-аппа, к которой всё относится.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS compensation jsonb;

CREATE INDEX IF NOT EXISTS audit_undoable_idx ON audit_log (user_id, at DESC)
  WHERE reversible AND reversed_at IS NULL;
