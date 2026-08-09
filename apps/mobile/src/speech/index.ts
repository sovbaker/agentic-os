/**
 * Порт распознавания речи.
 *
 * Метро подставляет платформенную реализацию: index.web.ts в вебе,
 * index.native.ts на устройстве. Этот файл — контракт и безопасная заглушка,
 * по которой типизируется всё остальное.
 *
 * Голос никогда не бывает единственным входом: если распознавание недоступно
 * или в нём отказано, поле ввода остаётся рабочим.
 */

export interface SpeechSession {
  stop: () => void;
}

export interface SpeechPort {
  isAvailable: () => boolean;
  /**
   * @param onPartial промежуточный текст — показываем сразу, чтобы ожидание
   *                  не выглядело зависанием
   * @param onFinal   итоговый текст
   */
  start: (
    onPartial: (text: string) => void,
    onFinal: (text: string) => void,
    onError: (message: string) => void
  ) => Promise<SpeechSession | null>;
}

export const speech: SpeechPort = {
  isAvailable: () => false,
  start: async (_p, _f, onError) => {
    onError('Распознавание речи недоступно на этой платформе');
    return null;
  },
};
