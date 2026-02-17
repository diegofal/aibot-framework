import { describe, test, expect } from 'bun:test';
import { createExecTool } from '../../src/tools/exec';

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createMockLogger(),
    fatal: () => {},
    trace: () => {},
    level: 'info',
    silent: () => {},
  } as any;
}

const logger = createMockLogger();

describe('exec tool', () => {
  describe('definition', () => {
    const tool = createExecTool();

    test('has correct name', () => {
      expect(tool.definition.function.name).toBe('exec');
    });

    test('has type function', () => {
      expect(tool.definition.type).toBe('function');
    });

    test('requires command parameter', () => {
      const params = tool.definition.function.parameters as any;
      expect(params.required).toContain('command');
    });
  });

  describe('BUILTIN_DENIED patterns', () => {
    const tool = createExecTool();

    test('blocks rm -rf /', async () => {
      const result = await tool.execute({ command: 'rm -rf /' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks rm /', async () => {
      const result = await tool.execute({ command: 'rm /' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks rm -f /', async () => {
      const result = await tool.execute({ command: 'rm -f /' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks mkfs', async () => {
      const result = await tool.execute({ command: 'mkfs.ext4 /dev/sda1' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks dd of=/dev/', async () => {
      const result = await tool.execute({ command: 'dd if=/dev/zero of=/dev/sda bs=1M' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks fork bomb', async () => {
      const result = await tool.execute({ command: ':(){ :|:& };:' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks writing to /dev/sd*', async () => {
      // Regex requires word boundary before >, so word char must precede >
      const result = await tool.execute({ command: 'cat>/dev/sda' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks chmod 777 /', async () => {
      const result = await tool.execute({ command: 'chmod 777 /' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks chmod -R 777 /', async () => {
      const result = await tool.execute({ command: 'chmod -R 777 /' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks shutdown', async () => {
      const result = await tool.execute({ command: 'shutdown -h now' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks reboot', async () => {
      const result = await tool.execute({ command: 'reboot' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks init 0', async () => {
      const result = await tool.execute({ command: 'init 0' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('blocks init 6', async () => {
      const result = await tool.execute({ command: 'init 6' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });

    test('allows safe rm commands', async () => {
      const result = await tool.execute({ command: 'rm /tmp/test-exec-safe.txt' }, logger);
      // This should NOT be blocked (it's a specific file, not /)
      // It may fail because file doesn't exist, but not blocked by safety
      expect(result.content).not.toContain('blocked by safety rule');
    });
  });

  describe('custom deniedPatterns', () => {
    const tool = createExecTool({
      deniedPatterns: ['\\bcurl\\b', '\\bwget\\b'],
    });

    test('blocks commands matching denied patterns', async () => {
      const result = await tool.execute({ command: 'curl https://example.com' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by deny pattern');
    });

    test('blocks wget', async () => {
      const result = await tool.execute({ command: 'wget https://example.com' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by deny pattern');
    });

    test('allows non-matching commands', async () => {
      const result = await tool.execute({ command: 'echo hello' }, logger);
      expect(result.success).toBe(true);
    });
  });

  describe('allowedPatterns (whitelist mode)', () => {
    test('empty allowedPatterns permits all commands', async () => {
      const tool = createExecTool({ allowedPatterns: [] });
      const result = await tool.execute({ command: 'echo hello' }, logger);
      expect(result.success).toBe(true);
    });

    test('non-empty allowedPatterns blocks non-matching commands', async () => {
      const tool = createExecTool({ allowedPatterns: ['^echo\\b'] });
      const result = await tool.execute({ command: 'ls -la' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('not permitted by allowlist');
    });

    test('non-empty allowedPatterns permits matching commands', async () => {
      const tool = createExecTool({ allowedPatterns: ['^echo\\b'] });
      const result = await tool.execute({ command: 'echo hello' }, logger);
      expect(result.success).toBe(true);
    });

    test('deny takes precedence over allow', async () => {
      const tool = createExecTool({
        allowedPatterns: ['.*'],  // allow everything
        deniedPatterns: ['\\becho\\b'],  // but deny echo
      });
      const result = await tool.execute({ command: 'echo hello' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by deny pattern');
    });

    test('builtin deny takes precedence over allow', async () => {
      const tool = createExecTool({
        allowedPatterns: ['.*'],  // allow everything
      });
      const result = await tool.execute({ command: 'reboot' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked by safety rule');
    });
  });

  describe('input validation', () => {
    const tool = createExecTool();

    test('rejects missing command', async () => {
      const result = await tool.execute({}, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Missing required parameter: command');
    });

    test('rejects empty command', async () => {
      const result = await tool.execute({ command: '  ' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Missing required parameter: command');
    });
  });

  describe('execution', () => {
    const tool = createExecTool();

    test('runs simple echo and returns output', async () => {
      const result = await tool.execute({ command: 'echo hello' }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('Exit code: 0');
      expect(result.content).toContain('hello');
    });

    test('reports non-zero exit code', async () => {
      const result = await tool.execute({ command: 'exit 42' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Exit code: 42');
    });

    test('captures stderr with separator', async () => {
      const result = await tool.execute({ command: 'echo out && echo err >&2' }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('out');
      expect(result.content).toContain('--- stderr ---');
      expect(result.content).toContain('err');
    });

    test('reports (no output) for empty commands', async () => {
      const result = await tool.execute({ command: 'true' }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('(no output)');
    });
  });

  describe('output truncation', () => {
    test('truncates output exceeding maxOutputLength', async () => {
      const tool = createExecTool({ maxOutputLength: 50 });
      const result = await tool.execute(
        { command: 'python3 -c "print(\'x\' * 200)"' },
        logger,
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain('truncated');
      expect(result.content).toContain('total chars');
    });

    test('does not truncate short output', async () => {
      const tool = createExecTool({ maxOutputLength: 10000 });
      const result = await tool.execute({ command: 'echo short' }, logger);
      expect(result.success).toBe(true);
      expect(result.content).not.toContain('truncated');
    });
  });

  describe('workdir parameter', () => {
    test('uses configured workdir', async () => {
      const tool = createExecTool({ workdir: '/tmp' });
      const result = await tool.execute({ command: 'pwd' }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('/tmp');
    });

    test('per-call workdir overrides default', async () => {
      const tool = createExecTool({ workdir: '/home' });
      const result = await tool.execute({ command: 'pwd', workdir: '/tmp' }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('/tmp');
    });
  });

  describe('timeout', () => {
    test('kills long-running process after timeout', async () => {
      const tool = createExecTool({ timeout: 500 });
      const start = Date.now();
      const result = await tool.execute({ command: 'sleep 30' }, logger);
      const elapsed = Date.now() - start;

      // Should finish well before 30s
      expect(elapsed).toBeLessThan(5000);
      // Process was killed
      expect(result.content).toContain('Exit code:');
    });
  });

  describe('background mode', () => {
    test('without processToolConfig, runs in foreground', async () => {
      const tool = createExecTool();
      const result = await tool.execute({ command: 'echo bg', background: true }, logger);
      // Without processToolConfig, background=true is ignored, runs normally
      expect(result.success).toBe(true);
      expect(result.content).toContain('Exit code: 0');
      expect(result.content).toContain('bg');
    });

    test('with processToolConfig, returns session ID', async () => {
      const tool = createExecTool({
        processToolConfig: { maxSessions: 10, finishedTtlMs: 60000, maxOutputChars: 10000 },
      });
      const result = await tool.execute({ command: 'echo bg-test', background: true }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('Background process started');
      expect(result.content).toContain('Session ID:');
      expect(result.content).toContain('PID:');
    });

    test('foreground ignores processToolConfig when background=false', async () => {
      const tool = createExecTool({
        processToolConfig: { maxSessions: 10, finishedTtlMs: 60000, maxOutputChars: 10000 },
      });
      const result = await tool.execute({ command: 'echo fg', background: false }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('Exit code: 0');
      expect(result.content).toContain('fg');
    });
  });
});
