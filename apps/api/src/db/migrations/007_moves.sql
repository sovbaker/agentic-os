-- Данные, без которых компоненты агентности печатали бы фальшивую точность.

/* Срок обратимости.
   `reversible boolean` отвечает на «можно ли отменить», но не на «до какого
   момента». Показать «отменить» без срока — значит однажды показать кнопку,
   которая уже ничего не отменит; показать срок, вычисленный на клиенте, —
   значит выдумать его. */
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS reversible_until timestamptz;

/* Ожидание третьей стороны.
   Состояния «жду ответа от визового центра» в модели не существовало вовсе:
   задача была либо running, либо waiting_user. Без этих полей компонент
   «жду ответа» нечем наполнить. */
ALTER TABLE job ADD COLUMN IF NOT EXISTS awaiting_who text;
ALTER TABLE job ADD COLUMN IF NOT EXISTS awaiting_since timestamptz;
ALTER TABLE job ADD COLUMN IF NOT EXISTS awaiting_usually text;

/* Срок самой задачи.
   Раньше срок жил только фактом в графе и строкой в заголовке мини-аппы,
   поэтому ни лента, ни метрики не могли о нём спросить. */
ALTER TABLE job ADD COLUMN IF NOT EXISTS due_at timestamptz;

CREATE INDEX IF NOT EXISTS job_due_idx ON job (user_id, due_at) WHERE due_at IS NOT NULL;
