import { join } from 'node:path';
import type { Config } from '../config';
import type { FetchLike } from './http';
import { PersonalAccountService } from './service';

export {
  PersonalAccountService,
  ReauthNeededError,
  isPersonalProvider,
  type CompleteLoginResult,
} from './service';
export * from './types';
export { freeSlots, mergeAgenda, type AgendaRow, type FreeSlot } from './calendar-merge';

export const DEFAULT_REDIRECT_BASE = 'http://127.0.0.1:3000';

/** The fleet's personal accounts: `<paths.data>/personal-accounts`, client ids from the environment. */
export function createPersonalAccounts(
  config: Config,
  deps: { env?: Record<string, string | undefined>; fetch?: FetchLike } = {}
): PersonalAccountService {
  return new PersonalAccountService({
    rootDir: join(config.paths.data, 'personal-accounts'),
    redirectBase: config.integrations?.personalAccounts?.redirectBaseUrl ?? DEFAULT_REDIRECT_BASE,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
