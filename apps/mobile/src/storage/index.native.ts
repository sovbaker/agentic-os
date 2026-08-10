import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { TOKEN_KEY } from './keys';

/**
 * Токен устройства в системном хранилище ключей.
 *
 * AsyncStorage — это незашифрованный файл в песочнице приложения. На
 * устройстве без джейлбрейка до него не добраться, но он попадает в
 * незашифрованный бэкап и в файловую выгрузку при отладке. Токен здесь
 * равносилен аккаунту, так что его место — в Keychain (iOS) и Keystore
 * (Android), куда система не пускает другие приложения и что не уезжает
 * в бэкап как обычный файл.
 *
 * `AFTER_FIRST_UNLOCK` — не послабление: приложение просыпается по пушу,
 * в том числе когда экран заблокирован, и с более строгим уровнем оно
 * в этот момент не смогло бы прочитать собственный токен.
 */

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/**
 * Ключ Keychain не терпит `/`, в отличие от ключа AsyncStorage.
 * Поэтому имена разные — и это же различие делает переезд однозначным.
 */
const SECURE_KEY = 'device_token';

/**
 * Переезд со старого места. Выполняется один раз: у того, кто уже
 * поставил сборку до этого изменения, токен лежит в AsyncStorage, и
 * потерять его — значит завести человеку новый пустой аккаунт вместо
 * его собственного.
 */
async function migrate(): Promise<string | null> {
  try {
    const legacy = await AsyncStorage.getItem(TOKEN_KEY);
    if (!legacy) return null;

    await SecureStore.setItemAsync(SECURE_KEY, legacy, OPTIONS);
    // Удаляем только после успешной записи: иначе окно между двумя
    // операциями — это потерянный аккаунт.
    await AsyncStorage.removeItem(TOKEN_KEY);
    return legacy;
  } catch {
    return null;
  }
}

export async function loadToken(): Promise<string | null> {
  try {
    const token = await SecureStore.getItemAsync(SECURE_KEY, OPTIONS);
    if (token) return token;
  } catch {
    // Keychain недоступен (первый запуск до разблокировки) — пробуем
    // старое место, дальше вернём null и зарегистрируемся заново.
  }
  return migrate();
}

export async function saveToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(SECURE_KEY, token, OPTIONS);
  } catch {
    // Не критично: приложение работает и с токеном только в памяти.
  }
}
