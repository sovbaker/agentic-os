-- S4: учёт расхода, лимиты и приватность.

/* Каждый вызов модели с разбивкой токенов.
   Без этого «стоимость закрытой задачи ≤25 ₽» — не метрика, а пожелание. */
CREATE TABLE IF NOT EXISTS llm_call (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid REFERENCES app_user(id) ON DELETE CASCADE,
  job_id                uuid REFERENCES job(id) ON DELETE SET NULL,
  role                  text NOT NULL,          -- router | planner | executor | extractor | composer
  model                 text NOT NULL,
  input_tokens          int  NOT NULL DEFAULT 0,
  output_tokens         int  NOT NULL DEFAULT 0,
  /* Кэш считается отдельно: чтение дешевле входа примерно вдесятеро,
     запись — дороже. Складывать их в один счётчик значит потерять эффект. */
  cache_read_tokens     int  NOT NULL DEFAULT 0,
  cache_write_tokens    int  NOT NULL DEFAULT 0,
  cost_rub              numeric(12, 4) NOT NULL DEFAULT 0,
  latency_ms            int,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_call_user_time_idx ON llm_call (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_call_job_idx ON llm_call (job_id);

/* Тариф пользователя. Лимиты живут в коде, а не в базе: менять их
   миграцией на каждой итерации ценообразования — лишняя работа. */
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

/* Экспорт и удаление данных — требование закона и аргумент доверия
   в продукте про личную жизнь. Запрос фиксируется, чтобы был след.

   Ссылка НЕ каскадная, а SET NULL: после удаления пользователя запись
   должна пережить его самого — иначе единственное доказательство того,
   что удаление состоялось, исчезает вместе с удалением. */
CREATE TABLE IF NOT EXISTS privacy_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('export', 'delete')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
