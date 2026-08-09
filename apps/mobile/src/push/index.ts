/**
 * Порт пуш-токена.
 *
 * На iOS фоновой работы фактически нет, поэтому пуш — единственный канал
 * проактивности. Метро подставляет платформенную реализацию; этот файл —
 * контракт и безопасная заглушка.
 */
export interface PushPort {
  register(): Promise<string | null>;
}

export const pushTokens: PushPort = {
  register: async () => null,
};
