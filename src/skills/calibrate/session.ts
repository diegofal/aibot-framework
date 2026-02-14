import type { DataStore } from '../../core/types';
import type { CalibrationSession, CalibrateScope, ClaimBatch } from './types';

const SESSION_PREFIX = 'cal-session:';

function sessionKey(chatId: number, userId: number): string {
  return `${SESSION_PREFIX}${chatId}:${userId}`;
}

export function getSession(data: DataStore, chatId: number, userId: number): CalibrationSession | undefined {
  return data.get<CalibrationSession>(sessionKey(chatId, userId));
}

export function createSession(
  data: DataStore,
  chatId: number,
  userId: number,
  scope: CalibrateScope,
  batches: ClaimBatch[],
): CalibrationSession {
  const session: CalibrationSession = {
    phase: 'reviewing',
    chatId,
    userId,
    scope,
    batches,
    currentBatchIndex: 0,
    rewrites: [],
    lastActivity: Date.now(),
  };
  data.set(sessionKey(chatId, userId), session);
  return session;
}

export function saveSession(data: DataStore, session: CalibrationSession): void {
  session.lastActivity = Date.now();
  data.set(sessionKey(session.chatId, session.userId), session);
}

export function deleteSession(data: DataStore, chatId: number, userId: number): void {
  data.delete(sessionKey(chatId, userId));
}

export function isSessionExpired(session: CalibrationSession, timeoutMs: number): boolean {
  return Date.now() - session.lastActivity > timeoutMs;
}
