import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PERMISSIONS,
  NATIVE_TOOL_MAP,
  type PermissionMode,
  type ToolPermissionEntry,
  buildSensitiveActionProtocol,
  getBlockedNativeTools,
  getBlockedTools,
  getPermissionLevel,
} from '../src/bot/tool-permissions';

describe('tool-permissions', () => {
  describe('getPermissionLevel', () => {
    it('returns default level for known tools', () => {
      expect(getPermissionLevel('exec', 'agent-loop')).toBe('confirm');
      expect(getPermissionLevel('exec', 'conversation')).toBe('confirm');
    });

    it('returns free for unknown tools', () => {
      expect(getPermissionLevel('unknown_tool', 'agent-loop')).toBe('free');
      expect(getPermissionLevel('unknown_tool', 'conversation')).toBe('free');
    });

    it('applies bot overrides over defaults', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        exec: { conversation: 'confirm' },
      };
      expect(getPermissionLevel('exec', 'conversation', overrides)).toBe('confirm');
      // Non-overridden mode still uses default
      expect(getPermissionLevel('exec', 'agent-loop', overrides)).toBe('confirm');
    });

    it('applies override for unknown tool', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        my_custom_tool: { conversation: 'blocked' },
      };
      expect(getPermissionLevel('my_custom_tool', 'conversation', overrides)).toBe('blocked');
      expect(getPermissionLevel('my_custom_tool', 'agent-loop', overrides)).toBe('free');
    });

    it('safe tools are free everywhere', () => {
      for (const tool of ['get_datetime', 'memory_search', 'web_search', 'manage_goals']) {
        expect(getPermissionLevel(tool, 'agent-loop')).toBe('free');
        expect(getPermissionLevel(tool, 'conversation')).toBe('free');
      }
    });

    it('dangerous tools require confirm in conversation by default', () => {
      // Most dangerous tools now use inline approval (confirm) instead of blocked
      for (const tool of ['exec', 'process', 'browser', 'file_write', 'file_edit']) {
        expect(getPermissionLevel(tool, 'conversation')).toBe('confirm');
      }
      // phone_call stays blocked — too dangerous for inline approval
      expect(getPermissionLevel('phone_call', 'conversation')).toBe('blocked');
    });

    it('dangerous tools are confirm in agent-loop by default', () => {
      for (const tool of ['exec', 'process', 'browser', 'phone_call']) {
        expect(getPermissionLevel(tool, 'agent-loop')).toBe('confirm');
      }
    });
  });

  describe('getBlockedTools', () => {
    it('returns blocked tools for conversation mode', () => {
      const allTools = ['get_datetime', 'exec', 'file_read', 'web_search', 'browser', 'phone_call'];
      const blocked = getBlockedTools('conversation', allTools);
      // exec and browser are now confirm (inline approval), not blocked
      expect(blocked).not.toContain('exec');
      expect(blocked).not.toContain('browser');
      // phone_call stays blocked
      expect(blocked).toContain('phone_call');
      expect(blocked).not.toContain('get_datetime');
      expect(blocked).not.toContain('web_search');
      expect(blocked).not.toContain('file_read');
    });

    it('returns empty for agent-loop (no tools blocked by default)', () => {
      const allTools = Object.keys(DEFAULT_PERMISSIONS);
      const blocked = getBlockedTools('agent-loop', allTools);
      expect(blocked).toHaveLength(0);
    });

    it('respects overrides', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        web_search: { conversation: 'blocked' },
      };
      const blocked = getBlockedTools('conversation', ['web_search', 'get_datetime'], overrides);
      expect(blocked).toContain('web_search');
      expect(blocked).not.toContain('get_datetime');
    });
  });

  describe('buildSensitiveActionProtocol', () => {
    it('returns null when all tools are free', () => {
      const result = buildSensitiveActionProtocol('agent-loop', ['get_datetime', 'web_search']);
      expect(result).toBeNull();
    });

    it('returns null when all tools are free in conversation', () => {
      const result = buildSensitiveActionProtocol('conversation', ['get_datetime', 'web_search']);
      expect(result).toBeNull();
    });

    it('includes inform tools in conversation', () => {
      const result = buildSensitiveActionProtocol('conversation', [
        'cron',
        'get_datetime',
        'send_proactive_message',
      ]);
      expect(result).not.toBeNull();
      expect(result).toContain('Sensitive Action Protocol');
      expect(result).toContain('cron');
      expect(result).toContain('send_proactive_message');
    });

    it('includes confirm tools in agent-loop', () => {
      const result = buildSensitiveActionProtocol('agent-loop', ['exec', 'get_datetime']);
      expect(result).not.toBeNull();
      expect(result).toContain('exec');
      expect(result).toContain('confirmation');
    });
  });

  describe('getBlockedNativeTools', () => {
    it('returns empty when no tools are blocked', () => {
      const allTools = ['get_datetime', 'web_search', 'memory_search'];
      const result = getBlockedNativeTools('conversation', allTools);
      expect(result).toHaveLength(0);
    });

    it('maps blocked exec to Bash native tool', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        exec: { conversation: 'blocked' },
      };
      const allTools = ['exec', 'get_datetime', 'web_search'];
      const result = getBlockedNativeTools('conversation', allTools, overrides);
      expect(result).toContain('Bash');
      expect(result).toHaveLength(1);
    });

    it('maps blocked file_write to Write native tool', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        file_write: { conversation: 'blocked' },
      };
      const allTools = ['file_write', 'exec'];
      const result = getBlockedNativeTools('conversation', allTools, overrides);
      expect(result).toContain('Write');
      expect(result).not.toContain('Bash');
    });

    it('maps blocked browser to WebFetch and WebSearch', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        browser: { conversation: 'blocked' },
      };
      const allTools = ['browser', 'exec'];
      const result = getBlockedNativeTools('conversation', allTools, overrides);
      expect(result).toContain('WebFetch');
      expect(result).toContain('WebSearch');
      expect(result).not.toContain('Bash');
    });

    it('accumulates native tools from multiple blocked framework tools', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        exec: { conversation: 'blocked' },
        file_write: { conversation: 'blocked' },
        file_read: { conversation: 'blocked' },
        browser: { conversation: 'blocked' },
      };
      const allTools = ['exec', 'file_write', 'file_read', 'browser'];
      const result = getBlockedNativeTools('conversation', allTools, overrides);
      expect(result).toContain('Bash');
      expect(result).toContain('Write');
      expect(result).toContain('Read');
      expect(result).toContain('WebFetch');
      expect(result).toContain('WebSearch');
      expect(result).toHaveLength(5);
    });

    it('uses agent-loop mode correctly', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        exec: { agentLoop: 'blocked' },
      };
      const allTools = ['exec', 'get_datetime'];
      const result = getBlockedNativeTools('agent-loop', allTools, overrides);
      expect(result).toContain('Bash');
    });

    it('ignores blocked tools that have no native mapping', () => {
      const overrides: Record<string, Partial<ToolPermissionEntry>> = {
        phone_call: { conversation: 'blocked' },
      };
      const allTools = ['phone_call', 'exec'];
      const result = getBlockedNativeTools('conversation', allTools, overrides);
      // phone_call is blocked but has no native tool mapping
      expect(result).toHaveLength(0);
    });
  });

  describe('NATIVE_TOOL_MAP', () => {
    it('covers exec, file_write, file_edit, file_read, browser', () => {
      expect(NATIVE_TOOL_MAP).toHaveProperty('exec');
      expect(NATIVE_TOOL_MAP).toHaveProperty('file_write');
      expect(NATIVE_TOOL_MAP).toHaveProperty('file_edit');
      expect(NATIVE_TOOL_MAP).toHaveProperty('file_read');
      expect(NATIVE_TOOL_MAP).toHaveProperty('browser');
    });

    it('maps to correct Claude CLI native tools', () => {
      expect(NATIVE_TOOL_MAP.exec).toEqual(['Bash']);
      expect(NATIVE_TOOL_MAP.file_write).toEqual(['Write']);
      expect(NATIVE_TOOL_MAP.file_edit).toEqual(['Edit']);
      expect(NATIVE_TOOL_MAP.file_read).toEqual(['Read']);
      expect(NATIVE_TOOL_MAP.browser).toEqual(['WebFetch', 'WebSearch']);
    });
  });

  describe('DEFAULT_PERMISSIONS coverage', () => {
    it('has entries for critical tools', () => {
      const criticalTools = [
        'exec',
        'process',
        'browser',
        'file_read',
        'file_write',
        'file_edit',
        'phone_call',
        'twitter_post',
        'create_tool',
        'create_agent',
        'improve',
      ];
      for (const tool of criticalTools) {
        expect(DEFAULT_PERMISSIONS[tool]).toBeDefined();
      }
    });

    it('no tool is blocked in agent-loop mode', () => {
      for (const [_name, entry] of Object.entries(DEFAULT_PERMISSIONS)) {
        expect(entry.agentLoop).not.toBe('blocked');
      }
    });

    it('has exactly 2 fields per entry', () => {
      for (const [name, entry] of Object.entries(DEFAULT_PERMISSIONS)) {
        expect(entry).toHaveProperty('agentLoop');
        expect(entry).toHaveProperty('conversation');
      }
    });
  });
});
