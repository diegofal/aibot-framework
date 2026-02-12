import type { Subprocess } from 'bun';
import type { Tool, ToolResult } from './types';
import type { Logger } from '../logger';

export interface ProcessToolConfig {
  maxSessions?: number;
  finishedTtlMs?: number;
  maxOutputChars?: number;
}

interface ProcessSession {
  id: string;
  command: string;
  proc: Subprocess;
  pid: number;
  startedAt: number;
  /** Accumulated output (stdout + stderr interleaved) */
  output: string;
  /** Output not yet consumed by poll */
  pending: string;
}

interface FinishedSession {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  output: string;
  pending: string;
}

// ─── Process Registry (singleton) ───────────────────────────

const activeSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, FinishedSession>();
let idCounter = 0;
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

function startSweeper(ttlMs: number): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of finishedSessions) {
      if (now - session.finishedAt > ttlMs) {
        finishedSessions.delete(id);
      }
    }
  }, Math.min(ttlMs, 60_000));
}

/**
 * Register a background process in the registry.
 * Called by exec tool when background=true.
 */
export function registerProcess(
  command: string,
  proc: Subprocess,
  config: ProcessToolConfig,
  logger: Logger,
): { sessionId: string; pid: number } {
  const maxSessions = config.maxSessions ?? 10;
  const maxOutput = config.maxOutputChars ?? 200_000;
  const ttlMs = config.finishedTtlMs ?? 600_000;

  if (activeSessions.size >= maxSessions) {
    throw new Error(`Max background sessions reached (${maxSessions}). Kill or clear existing ones first.`);
  }

  const id = `proc_${++idCounter}`;
  const pid = proc.pid;

  const session: ProcessSession = {
    id,
    command,
    proc,
    pid,
    startedAt: Date.now(),
    output: '',
    pending: '',
  };

  activeSessions.set(id, session);

  // Drain stdout in background
  if (proc.stdout) {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          session.output += text;
          session.pending += text;
          // Trim if too large
          if (session.output.length > maxOutput) {
            session.output = session.output.slice(-maxOutput);
          }
          if (session.pending.length > maxOutput) {
            session.pending = session.pending.slice(-maxOutput);
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }

  // Drain stderr in background
  if (proc.stderr) {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          session.output += text;
          session.pending += text;
          if (session.output.length > maxOutput) {
            session.output = session.output.slice(-maxOutput);
          }
          if (session.pending.length > maxOutput) {
            session.pending = session.pending.slice(-maxOutput);
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }

  // When process exits, move to finished
  proc.exited.then((exitCode) => {
    const active = activeSessions.get(id);
    if (active) {
      activeSessions.delete(id);
      finishedSessions.set(id, {
        id,
        command: active.command,
        pid: active.pid,
        startedAt: active.startedAt,
        finishedAt: Date.now(),
        exitCode,
        output: active.output,
        pending: active.pending,
      });
    }
  });

  startSweeper(ttlMs);

  logger.info({ sessionId: id, pid, command }, 'process: registered background process');
  return { sessionId: id, pid };
}

// ─── process tool ───────────────────────────────────────────

export function createProcessTool(config: ProcessToolConfig = {}): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'process',
        description:
          'Manage background processes. Actions: ' +
          '"list" — list running and recently finished processes. ' +
          '"poll" — read new output from a process (drains pending buffer). ' +
          '"write" — send input to a running process\'s stdin. ' +
          '"kill" — kill a running process. ' +
          '"clear" — remove a finished process from the registry.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'poll', 'write', 'kill', 'clear'],
              description: 'The action to perform',
            },
            session_id: {
              type: 'string',
              description: 'Session ID (required for poll, write, kill, clear)',
            },
            input: {
              type: 'string',
              description: 'Input text to send to stdin (only for "write" action)',
            },
          },
          required: ['action'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const action = String(args.action ?? '').trim();
      const sessionId = String(args.session_id ?? '').trim();

      switch (action) {
        case 'list': {
          const lines: string[] = [];

          if (activeSessions.size === 0 && finishedSessions.size === 0) {
            return { success: true, content: 'No background processes.' };
          }

          for (const s of activeSessions.values()) {
            const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
            lines.push(
              `[RUNNING] ${s.id} — PID ${s.pid} — ${elapsed}s — ${s.command}`
            );
          }

          for (const s of finishedSessions.values()) {
            const elapsed = Math.round((s.finishedAt - s.startedAt) / 1000);
            lines.push(
              `[FINISHED] ${s.id} — PID ${s.pid} — exit ${s.exitCode} — ${elapsed}s — ${s.command}`
            );
          }

          logger.info({ active: activeSessions.size, finished: finishedSessions.size }, 'process: list');
          return { success: true, content: lines.join('\n') };
        }

        case 'poll': {
          if (!sessionId) {
            return { success: false, content: 'Missing required parameter: session_id' };
          }

          // Check active first
          const active = activeSessions.get(sessionId);
          if (active) {
            const output = active.pending || '(no new output)';
            active.pending = '';
            logger.info({ sessionId, bytes: output.length }, 'process: poll (active)');
            return { success: true, content: `[RUNNING] PID ${active.pid}\n\n${output}` };
          }

          // Check finished
          const finished = finishedSessions.get(sessionId);
          if (finished) {
            const output = finished.pending || '(no new output)';
            finished.pending = '';
            logger.info({ sessionId, bytes: output.length }, 'process: poll (finished)');
            return {
              success: true,
              content: `[FINISHED] PID ${finished.pid} — exit code ${finished.exitCode}\n\n${output}`,
            };
          }

          return { success: false, content: `Unknown session: ${sessionId}` };
        }

        case 'write': {
          if (!sessionId) {
            return { success: false, content: 'Missing required parameter: session_id' };
          }
          const input = String(args.input ?? '');
          if (!input) {
            return { success: false, content: 'Missing required parameter: input' };
          }

          const session = activeSessions.get(sessionId);
          if (!session) {
            return { success: false, content: `Session not found or not running: ${sessionId}` };
          }

          try {
            const stdin = session.proc.stdin;
            if (!stdin) {
              return { success: false, content: `Process ${sessionId} has no stdin available` };
            }
            // Bun's stdin with 'pipe' is a FileSink
            const fileSink = stdin as import('bun').FileSink;
            fileSink.write(new TextEncoder().encode(input));
            fileSink.flush();
            logger.info({ sessionId, bytes: input.length }, 'process: write');
            return { success: true, content: `Sent ${input.length} bytes to ${sessionId}` };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, content: `Failed to write to stdin: ${msg}` };
          }
        }

        case 'kill': {
          if (!sessionId) {
            return { success: false, content: 'Missing required parameter: session_id' };
          }

          const session = activeSessions.get(sessionId);
          if (!session) {
            return { success: false, content: `Session not found or not running: ${sessionId}` };
          }

          try {
            session.proc.kill();
            logger.info({ sessionId, pid: session.pid }, 'process: kill');
            return { success: true, content: `Killed process ${sessionId} (PID ${session.pid})` };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, content: `Failed to kill process: ${msg}` };
          }
        }

        case 'clear': {
          if (!sessionId) {
            return { success: false, content: 'Missing required parameter: session_id' };
          }

          if (activeSessions.has(sessionId)) {
            return { success: false, content: `Session ${sessionId} is still running. Kill it first.` };
          }

          if (finishedSessions.delete(sessionId)) {
            logger.info({ sessionId }, 'process: clear');
            return { success: true, content: `Cleared session ${sessionId}` };
          }

          return { success: false, content: `Unknown session: ${sessionId}` };
        }

        default:
          return {
            success: false,
            content: `Unknown action: ${action}. Valid actions: list, poll, write, kill, clear`,
          };
      }
    },
  };
}
