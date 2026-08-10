import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Указатель на открытый экран.
 *
 * iOS выгружает фоновое приложение когда захочет — это норма, а не сбой.
 * До этого выгрузка означала, что человек, вернувшись, оказывался на
 * пустой ленте: мини-аппа, в которой он работал, жила только в памяти
 * процесса. Для продукта, где задача тянется днями, это худший из
 * возможных ответов на «я вернулся».
 *
 * Хранится только идентификатор, не содержимое. Экран собирает сервер —
 * значит и восстанавливать его должен сервер: локальная копия спеки
 * протухла бы ровно в тот момент, когда задача сдвинулась, и показала бы
 * человеку вчерашнее состояние с уверенным видом.
 */

const SCREEN_KEY = 'agentic-os/open-screen';

export interface OpenScreen {
  specId: string;
  jobId: string | null;
}

export async function loadScreen(): Promise<OpenScreen | null> {
  try {
    const raw = await AsyncStorage.getItem(SCREEN_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<OpenScreen>;
    if (typeof parsed.specId !== 'string' || !parsed.specId) return null;

    return { specId: parsed.specId, jobId: typeof parsed.jobId === 'string' ? parsed.jobId : null };
  } catch {
    // Битая запись — это просто «нечего восстанавливать», а не ошибка,
    // с которой надо идти к человеку.
    return null;
  }
}

export async function saveScreen(screen: OpenScreen | null): Promise<void> {
  try {
    if (screen) await AsyncStorage.setItem(SCREEN_KEY, JSON.stringify(screen));
    else await AsyncStorage.removeItem(SCREEN_KEY);
  } catch {
    // Не критично: в худшем случае вернёмся на ленту.
  }
}
