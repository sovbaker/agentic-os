-- Ядро схемы. Векторные колонки живут отдельно (002_vector.sql), потому что
-- pgvector есть не в каждом управляемом Postgres, а падать из-за этого нельзя.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

/* ------------------------------------------------------------------ */
/* Пользователи и устройства                                           */
/* ------------------------------------------------------------------ */

CREATE TABLE app_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locale      text NOT NULL DEFAULT 'ru-RU',
  timezone    text NOT NULL DEFAULT 'Europe/Moscow',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_name  text,
  -- Хранится только хэш: утечка базы не должна давать доступ к аккаунтам.
  token_hash   text NOT NULL UNIQUE,
  push_token   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_user_idx ON device (user_id);

/* ------------------------------------------------------------------ */
/* Life graph                                                          */
/* ------------------------------------------------------------------ */

CREATE TABLE entity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN (
                'person','place','org','thing','document','account','recurring','goal','constraint')),
  label       text NOT NULL,
  attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX entity_user_type_idx ON entity (user_id, type) WHERE archived_at IS NULL;
CREATE INDEX entity_attrs_idx ON entity USING gin (attrs);

CREATE TABLE fact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  subject_id    uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  predicate     text NOT NULL,
  object_id     uuid REFERENCES entity(id) ON DELETE CASCADE,
  object_value  jsonb,

  -- Провенанс: на любой факт надо уметь ответить «откуда ты это взял».
  source        text NOT NULL CHECK (source IN (
                  'user_said','user_confirmed','calendar','email','contacts','procedure','inferred')),
  source_ref    text,
  confidence    real NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
  observed_at   timestamptz NOT NULL DEFAULT now(),

  -- Битемпоральность: когда факт был истинным ≠ когда мы о нём узнали.
  valid_from    timestamptz,
  valid_to      timestamptz,

  -- Ничего не удаляем физически: история нужна, чтобы сказать
  -- «раньше ты говорил иначе».
  superseded_by uuid REFERENCES fact(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fact_current_idx ON fact (user_id, subject_id, predicate) WHERE valid_to IS NULL;
CREATE INDEX fact_predicate_idx ON fact (user_id, predicate) WHERE valid_to IS NULL;

/* Эпизодическая память: сырой append-only лог происходившего. */
CREATE TABLE episode (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  job_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX episode_user_time_idx ON episode (user_id, created_at DESC);

/* Дыры в знании: что спросить и насколько это дорого. */
CREATE TABLE knowledge_gap (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  question    text NOT NULL,
  predicate   text NOT NULL,
  blocks_jobs int NOT NULL DEFAULT 0,
  ask_cost    text NOT NULL DEFAULT 'cheap' CHECK (ask_cost IN ('cheap','medium','sensitive')),
  priority    real NOT NULL DEFAULT 0,
  asked_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* ------------------------------------------------------------------ */
/* Задачи                                                              */
/* ------------------------------------------------------------------ */

CREATE TABLE job (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  goal             text NOT NULL,
  status           text NOT NULL CHECK (status IN (
                     'planning','running','waiting_user','waiting_world','done','failed','cancelled')),
  artifacts        jsonb NOT NULL DEFAULT '[]'::jsonb,
  graph_refs       jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Для waiting_world: когда разбудить задачу.
  wake_at          timestamptz,
  -- Для waiting_user: что именно мы спросили.
  pending_question text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_user_status_idx ON job (user_id, status, updated_at DESC);
-- Воркеру нужно быстро находить, кого пора будить.
CREATE INDEX job_wake_idx ON job (wake_at) WHERE wake_at IS NOT NULL AND status = 'waiting_world';

CREATE TABLE job_step (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  idx             int NOT NULL,
  tool            text NOT NULL,
  args            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Без ключа идемпотентности ретрай означает второе письмо.
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN (
                    'pending','running','done','failed','skipped','compensated')),
  depends_on      jsonb NOT NULL DEFAULT '[]'::jsonb,
  result          jsonb,
  error           text,
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 3,
  postconditions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, idx)
);

/* ------------------------------------------------------------------ */
/* Мини-аппы                                                           */
/* ------------------------------------------------------------------ */

CREATE TABLE miniapp (
  id          text NOT NULL,
  version     int NOT NULL,
  -- NULL = общая мини-аппа из каталога, доступная всем.
  user_id     uuid REFERENCES app_user(id) ON DELETE CASCADE,
  title       text NOT NULL,
  origin      text NOT NULL CHECK (origin IN ('catalog','parameterized','generated')),
  spec        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE INDEX miniapp_user_idx ON miniapp (user_id, created_at DESC);

/* Состояние мини-аппы у конкретного пользователя: она живёт, а не показывается разово. */
CREATE TABLE miniapp_state (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  spec_id    text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, spec_id)
);

/* ------------------------------------------------------------------ */
/* Процедурная память                                                  */
/* ------------------------------------------------------------------ */

CREATE TABLE procedure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = обезличенный общий скелет, пригодный к переиспользованию.
  user_id        uuid REFERENCES app_user(id) ON DELETE CASCADE,
  name           text NOT NULL,
  trigger_spec   jsonb NOT NULL DEFAULT '{}'::jsonb,
  params_schema  jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps          jsonb NOT NULL DEFAULT '[]'::jsonb,
  postconditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  compensation   jsonb NOT NULL DEFAULT '[]'::jsonb,
  success_rate   real,
  runs           int NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified','quarantined')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

/* ------------------------------------------------------------------ */
/* Аудит и проактивность                                               */
/* ------------------------------------------------------------------ */

CREATE TABLE audit_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  job_id            uuid REFERENCES job(id) ON DELETE SET NULL,
  at                timestamptz NOT NULL DEFAULT now(),
  action            text NOT NULL,
  -- Человеческим языком, не JSON: пользователь должен понять без нас.
  human_readable    text NOT NULL,
  reason            text NOT NULL,
  permission        text NOT NULL CHECK (permission IN ('auto','confirm','never')),
  confirmed_by_user boolean NOT NULL DEFAULT false,
  reversible        boolean NOT NULL DEFAULT true,
  reversed_at       timestamptz
);

CREATE INDEX audit_user_time_idx ON audit_log (user_id, at DESC);

CREATE TABLE proactive_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN (
                  'morning_brief','did_for_you','need_decision','deadline','discovery')),
  title         text NOT NULL,
  body          text NOT NULL,
  job_id        uuid REFERENCES job(id) ON DELETE SET NULL,
  score         real NOT NULL DEFAULT 0,
  scheduled_for timestamptz NOT NULL,
  delivered_at  timestamptz,
  reaction      text CHECK (reaction IN ('opened','ignored','muted_class')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Бюджет «не более 3 в день» считается по этому индексу.
CREATE INDEX proactive_pending_idx ON proactive_event (user_id, scheduled_for)
  WHERE delivered_at IS NULL;
