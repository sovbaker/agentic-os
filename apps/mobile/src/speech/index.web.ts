import type { SpeechPort, SpeechSession } from './index';

/**
 * Веб-реализация на Web Speech API. Нужна не только для браузера:
 * это единственная платформа, на которой голосовой путь можно проверить
 * автоматически, без устройства.
 */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
}

function getConstructor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = w['SpeechRecognition'] ?? w['webkitSpeechRecognition'];
  return typeof ctor === 'function' ? (ctor as new () => SpeechRecognitionLike) : null;
}

function extract(event: unknown): { text: string; isFinal: boolean } {
  const results = (event as { results?: ArrayLike<ArrayLike<{ transcript?: string }> & { isFinal?: boolean }> })
    .results;
  if (!results) return { text: '', isFinal: false };

  let text = '';
  let isFinal = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) continue;
    const alternative = result[0];
    text += alternative?.transcript ?? '';
    if (result.isFinal) isFinal = true;
  }
  return { text: text.trim(), isFinal };
}

export const speech: SpeechPort = {
  isAvailable: () => getConstructor() !== null,

  start: async (onPartial, onFinal, onError): Promise<SpeechSession | null> => {
    const Ctor = getConstructor();
    if (!Ctor) {
      onError('Браузер не поддерживает распознавание речи');
      return null;
    }

    const recognition = new Ctor();
    recognition.lang = 'ru-RU';
    recognition.continuous = false;
    recognition.interimResults = true;

    let last = '';
    recognition.onresult = (event) => {
      const { text, isFinal } = extract(event);
      if (!text) return;
      last = text;
      if (isFinal) onFinal(text);
      else onPartial(text);
    };
    recognition.onerror = (event) => {
      const code = (event as { error?: string }).error ?? 'unknown';
      onError(code === 'not-allowed' ? 'Нет доступа к микрофону' : `Ошибка распознавания: ${code}`);
    };
    // Некоторые браузеры не присылают финальный результат — подстраховываемся
    // последним промежуточным, иначе надиктованное молча пропадёт.
    recognition.onend = () => {
      if (last) onFinal(last);
    };

    try {
      recognition.start();
    } catch {
      onError('Не удалось запустить распознавание');
      return null;
    }

    return { stop: () => recognition.stop() };
  },
};
