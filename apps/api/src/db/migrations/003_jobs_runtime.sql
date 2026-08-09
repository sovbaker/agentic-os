-- S1: исполнение задач переживает перезапуск процесса.
-- Всё состояние в базе; в памяти воркера не хранится ничего, что нельзя потерять.

/* Аренда задачи воркером. Без неё две реплики возьмут одну задачу
   и выполнят её дважды — а «дважды» здесь означает второе письмо. */
ALTER TABLE job ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE job ADD COLUMN IF NOT EXISTS locked_by    text;
ALTER TABLE job ADD COLUMN IF NOT EXISTS last_error   text;

CREATE INDEX IF NOT EXISTS job_runnable_idx ON job (status, locked_until)
  WHERE status IN ('planning', 'running');

ALTER TABLE job_step ADD COLUMN IF NOT EXISTS started_at  timestamptz;
ALTER TABLE job_step ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE job_step ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
/* Заголовок шага для карточки задачи: пользователь должен понимать,
   что происходит, без чтения названий инструментов. */
ALTER TABLE job_step ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
/* Чем откатывать шаг. «Обратимо» без этого — просто отметка, а не свойство. */
ALTER TABLE job_step ADD COLUMN IF NOT EXISTS compensation jsonb;

/* Локальный календарь. В S3 его заменят адаптеры EventKit и CalDAV,
   но порт и данные уже настоящие, а не заглушка. */
CREATE TABLE IF NOT EXISTS calendar_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  location    text,
  source      text NOT NULL DEFAULT 'local',
  external_id text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_user_time_idx ON calendar_event (user_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_external_idx ON calendar_event (user_id, source, external_id)
  WHERE external_id IS NOT NULL;

/* Карантин: что именно пришло из недоверенного источника и что из него
   извлечено. Хранится отдельно, чтобы сырой текст никогда не смешивался
   с доверенным контекстом даже случайно. */
CREATE TABLE IF NOT EXISTS quarantined_content (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  job_id        uuid REFERENCES job(id) ON DELETE CASCADE,
  tool          text NOT NULL,
  raw           text NOT NULL,
  extracted     jsonb NOT NULL DEFAULT '{}'::jsonb,
  injection_suspected boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quarantine_job_idx ON quarantined_content (job_id);
