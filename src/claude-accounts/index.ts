import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config';
import { ClaudeAccountService } from './service';

export { ClaudeAccountService, type ClaudeAccountStatus } from './service';

/** The fleet's account service: `<paths.data>/claude-accounts`, the current CLAUDE_CONFIG_DIR as `default`. */
export function createClaudeAccounts(config: Config): ClaudeAccountService {
  return new ClaudeAccountService({
    rootDir: join(config.paths.data, 'claude-accounts'),
    legacyDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    claudePath: config.improve?.claudePath ?? 'claude',
  });
}
