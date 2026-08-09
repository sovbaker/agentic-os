-- S3: проактивность, онбординг и входящие данные.

/* Обучение на реакции. Игнор — сильный отрицательный сигнал, и он обязан
   снижать частоту именно этого класса, а не всех подряд. */
CREATE TABLE IF NOT EXISTS notification_policy (
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  weight      real NOT NULL DEFAULT 1.0,
  sent        int  NOT NULL DEFAULT 0,
  opened      int  NOT NULL DEFAULT 0,
  ignored     int  NOT NULL DEFAULT 0,
  muted       boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

/* Дедупликация триггеров: один и тот же дедлайн не должен порождать
   уведомление каждый прогон сканера. */
ALTER TABLE proactive_event ADD COLUMN IF NOT EXISTS dedup_key text;
CREATE UNIQUE INDEX IF NOT EXISTS proactive_dedup_idx ON proactive_event (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

/* Состояние онбординга. Граф — побочный продукт использования, поэтому
   здесь хранится не анкета, а то, что уже сделано и чего ещё не хватает. */
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;

/* Адрес для пересылки писем: обход restricted scope у почтовых провайдеров.
   Пользователь сам решает, что мы видим, — это аргумент доверия, а не
   компромисс. */
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS inbox_key text;
CREATE UNIQUE INDEX IF NOT EXISTS app_user_inbox_idx ON app_user (inbox_key) WHERE inbox_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS proactive_delivered_idx ON proactive_event (user_id, delivered_at DESC)
  WHERE delivered_at IS NOT NULL;
