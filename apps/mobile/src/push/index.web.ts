import type { PushPort } from './index';

/** В вебе пушей нет — лента остаётся единственной поверхностью. */
export const pushTokens: PushPort = {
  register: async () => null,
};
