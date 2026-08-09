import AsyncStorage from '@react-native-async-storage/async-storage';

/** Токен устройства должен переживать перезапуск, иначе состояние мини-апп теряется. */
const TOKEN_KEY = 'agentic-os/device-token';

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
