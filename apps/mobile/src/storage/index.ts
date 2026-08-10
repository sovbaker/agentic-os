import AsyncStorage from '@react-native-async-storage/async-storage';
import { TOKEN_KEY } from './keys';

/**
 * Хранилище токена устройства.
 *
 * Токен — это и есть аккаунт: он даёт доступ ко всей памяти о человеке,
 * к его почте и к деньгам на его счёте у модели. Пароля, которым его можно
 * было бы перевыпустить, нет, поэтому цена утечки — не «перелогиниться».
 *
 * На устройстве он лежит в системном хранилище ключей (Keychain на iOS,
 * Keystore на Android) — см. `index.native.ts`. Этот файл — контракт и
 * веб-реализация: в браузере Keychain'а нет, а веб-экспорт нужен только
 * для проверки вёрстки, и настоящих аккаунтов в нём не бывает.
 */

export async function loadToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Не критично: приложение работает и с токеном только в памяти.
  }
}
