import type { SpeechPort, SpeechSession } from './index';

/**
 * Нативная реализация поверх expo-speech-recognition.
 *
 * ⚠️ Требует dev build: в Expo Go нативного модуля нет (см. docs/02-tech-critique.md, п.1).
 * Это единственная часть S0, которую нельзя проверить без устройства, поэтому
 * весь путь обёрнут в try/catch: при любой несовместимости голос деградирует
 * до текстового ввода, а не роняет приложение.
 */

interface RecognitionModule {
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  start: (options: { lang: string; interimResults: boolean; continuous: boolean }) => void;
  stop: () => void;
  addListener: (event: string, handler: (payload: unknown) => void) => { remove: () => void };
}

function loadModule(): RecognitionModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-speech-recognition') as {
      ExpoSpeechRecognitionModule?: RecognitionModule;
    };
    return mod.ExpoSpeechRecognitionModule ?? null;
  } catch {
    return null;
  }
}

function transcriptOf(payload: unknown): { text: string; isFinal: boolean } {
  const p = payload as { isFinal?: boolean; results?: Array<{ transcript?: string }> };
  return {
    text: (p.results?.[0]?.transcript ?? '').trim(),
    isFinal: p.isFinal === true,
  };
}

export const speech: SpeechPort = {
  isAvailable: () => loadModule() !== null,

  start: async (onPartial, onFinal, onError): Promise<SpeechSession | null> => {
    const mod = loadModule();
    if (!mod) {
      onError('Модуль распознавания не установлен в этой сборке');
      return null;
    }

    try {
      const permission = await mod.requestPermissionsAsync();
      if (!permission.granted) {
        onError('Нет доступа к микрофону');
        return null;
      }

      const subscriptions = [
        mod.addListener('result', (payload) => {
          const { text, isFinal } = transcriptOf(payload);
          if (!text) return;
          if (isFinal) onFinal(text);
          else onPartial(text);
        }),
        mod.addListener('error', (payload) => {
          const message = (payload as { message?: string }).message ?? 'неизвестная ошибка';
          onError(`Ошибка распознавания: ${message}`);
        }),
      ];

      mod.start({ lang: 'ru-RU', interimResults: true, continuous: false });

      return {
        stop: () => {
          try {
            mod.stop();
          } finally {
            subscriptions.forEach((s) => s.remove());
          }
        },
      };
    } catch (err) {
      onError(`Распознавание недоступно: ${(err as Error).message}`);
      return null;
    }
  },
};
