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
  getExpoPushTokenAsync: () => Promise<{ data: string }>;
  setNotificationHandler: (handler: unknown) => void;
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

      const token = await mod.getExpoPushTokenAsync();
      return token.data;
    } catch {
      return null;
    }
  },
};
