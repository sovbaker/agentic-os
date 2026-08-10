import { queryOne } from '../../db/client';
import { monthSpendRub, jobSpendRub } from './cost';

/**
 * Лимиты тарифов.
 *
 * Два разных ограничителя, и путать их нельзя:
 *
 *  - **продуктовый** (сколько задач в месяц) — то, что видит пользователь и
 *    что двигает его к подписке;
 *  - **предохранитель** (потолок расхода) — то, что спасает от отрицательной
 *    маржи на хвосте: зацикленный план или патологически длинная задача.
 *
 * Предохранитель не рекламируется и в норме не достигается. Если он
 * сработал — это сигнал разработчику, а не оффер пользователю.
 */

export type Plan = 'free' | 'pro';

export interface PlanLimits {
  /** null = без числового ограничения. */
  tasksPerMonth: number | null;
  /** Генерация мини-аппы моделью против каталога и параметризации. */
  generation: boolean;
  proactive: boolean;
  /** Предохранитель, ₽ в месяц. */
  monthlyCostRub: number;
}

export const PLANS: Record<Plan, PlanLimits> = {
  free: {
    tasksPerMonth: 5,
    generation: false,
    proactive: false,
    // Пять задач по бюджету 25 ₽ — это 125 ₽, но пять задач бесплатного
    // тарифа в норме идут по каталогу и стоят копейки. 75 ₽ ловит
    // зацикливание, не мешая нормальному сценарию.
    monthlyCostRub: 75,
  },
  pro: {
    tasksPerMonth: null,
    generation: true,
    proactive: true,
    // Подписка 1 490 ₽. Потолок в половину цены удерживает валовую маржу
    // около 50% даже у самого тяжёлого пользователя когорты.
    monthlyCostRub: 750,
  },
};

/** Бюджет одной задачи (архитектура, §8): долгая задача — до 25 ₽. */
export const TASK_BUDGET_RUB = 25;

export async function getPlan(userId: string): Promise<Plan> {
  const row = await queryOne<{ plan: string }>('SELECT plan FROM app_user WHERE id = $1', [userId]);
  return row?.plan === 'pro' ? 'pro' : 'free';
}

export type QuotaKind = 'task' | 'generation' | 'proactive';

export interface QuotaVerdict {
  allowed: boolean;
  /** Человеческим языком: это уедет прямо на экран. */
  reason?: string;
  used?: number;
  limit?: number | null;
  plan: Plan;
}

async function monthTaskCount(userId: string): Promise<number> {
  const row = await queryOne<{ c: string }>(
    /*
     * Упавшие задачи не считаются.
     *
     * Пять задач в месяц — это пять попыток получить пользу, а не пять
     * запусков. Человек, у которого всё упало, потратил месяц и не получил
     * ничего: брать с него ещё и лимит — значит наказывать за наш отказ.
     */
    `SELECT count(*)::text AS c FROM job
      WHERE user_id = $1
        AND created_at >= date_trunc('month', now())
        AND status <> 'failed'`,
    [userId]
  );
  return Number(row?.c ?? 0);
}

export async function checkQuota(userId: string, kind: QuotaKind): Promise<QuotaVerdict> {
  const plan = await getPlan(userId);
  const limits = PLANS[plan];

  // Предохранитель проверяем первым и для всех действий: он про деньги,
  // а не про тариф, и срабатывает раньше любого продуктового лимита.
  const spent = await monthSpendRub(userId);
  if (spent >= limits.monthlyCostRub) {
    return {
      allowed: false,
      reason: 'Достигнут месячный потолок расхода. Напиши нам — разберёмся, что пошло не так.',
      used: Math.round(spent),
      limit: limits.monthlyCostRub,
      plan,
    };
  }

  if (kind === 'task' && limits.tasksPerMonth !== null) {
    const used = await monthTaskCount(userId);
    if (used >= limits.tasksPerMonth) {
      return {
        allowed: false,
        reason: `На бесплатном тарифе ${limits.tasksPerMonth} задач в месяц. Использовано ${used}.`,
        used,
        limit: limits.tasksPerMonth,
        plan,
      };
    }
    return { allowed: true, used, limit: limits.tasksPerMonth, plan };
  }

  if (kind === 'generation' && !limits.generation) {
    // Отказ не означает «нет интерфейса»: компилятор всё равно отдаст
    // экран из каталога. Ограничивается только генерация моделью.
    return { allowed: false, reason: 'Генерация новых мини-апп доступна на Pro.', plan };
  }

  if (kind === 'proactive' && !limits.proactive) {
    return { allowed: false, reason: 'Проактивные напоминания доступны на Pro.', plan };
  }

  return { allowed: true, plan };
}

/**
 * Бюджет задачи. Проверяется перед дорогим шагом, а не после: смысл
 * бюджета в том, чтобы не потратить, а не в том, чтобы узнать о трате.
 */
export async function withinTaskBudget(jobId: string): Promise<boolean> {
  return (await jobSpendRub(jobId)) < TASK_BUDGET_RUB;
}
