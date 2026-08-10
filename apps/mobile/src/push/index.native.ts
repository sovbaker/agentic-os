import type { PushPort } from './index';

/**
 * Нативная регистрация пуш-токена.
 *
 * ⚠️ Требует dev build: в Expo Go пуши работают неточно и на чужом ключе.
 * Всё обёрнуто в try/catch — отсутствие пушей означает продукт без
 * проактивности, но не сломанное приложение.
 */
interface NotificationsModule {
  getPermissionsAsync: () => Promise<{ status: string }>;
  requestPermissionsAsync: () => Promise<{ status: string }>;
  getExpoPushTokenAsync: (options?: { projectId?: string }) => Promise<{ data: string }>;
  setNotificationHandler: (handler: unknown) => void;
}

/**
 * Идентификатор проекта EAS.
 *
 * Без него `getExpoPushTokenAsync` бросает — то есть пуши не появляются
 * молча, а продукт теряет единственный канал проактивности на iOS. Берём
 * из конфигурации сборки: в дев-клиенте он приходит из `app.json`.
 */
const PLACEHOLDER_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

function projectId(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require('expo-constants') as {
      default?: { expoConfig?: { extra?: { eas?: { projectId?: string } } } };
    };
    const id = Constants.default?.expoConfig?.extra?.eas?.projectId;

    /*
     * Заглушка в app.json до `eas init`. Отличить её от настоящего
     * идентификатора важнее, чем кажется: с ней регистрация падает
     * внутри Expo, ловится нашим catch и возвращает null — то есть
     * пуши не работают, и об этом нигде не сказано ни слова.
     */
    if (id === PLACEHOLDER_PROJECT_ID) {
      console.warn('projectId — заглушка: выполни `eas init`, иначе пуши не заработают');
      return undefined;
    }
    return id;
  } catch {
    return undefined;
  }
}

function load(): NotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

export const pushTokens: PushPort = {
  register: async () => {
    const mod = load();
    if (!mod) return null;

    try {
      const existing = await mod.getPermissionsAsync();
      const status = existing.status === 'granted' ? existing : await mod.requestPermissionsAsync();
      if (status.status !== 'granted') return null;

      const id = projectId();
      const token = await mod.getExpoPushTokenAsync(id ? { projectId: id } : undefined);
      return token.data;
    } catch {
      return null;
    }
  },
};
