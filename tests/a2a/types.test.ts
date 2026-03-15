import { describe, expect, it } from 'bun:test';
import { A2A_ERROR } from '../../src/a2a/types';
import type {
  A2AMessage,
  AgentCard,
  Artifact,
  DataPart,
  FilePart,
  JsonRpcRequest,
  JsonRpcResponse,
  Task,
  TaskState,
  TextPart,
} from '../../src/a2a/types';

describe('A2A types', () => {
  describe('A2A_ERROR constants', () => {
    it('has correct error codes', () => {
      expect(A2A_ERROR.TASK_NOT_FOUND).toBe(-32001);
      expect(A2A_ERROR.TASK_NOT_CANCELABLE).toBe(-32002);
      expect(A2A_ERROR.PUSH_NOT_SUPPORTED).toBe(-32003);
      expect(A2A_ERROR.CONTENT_TYPE_NOT_SUPPORTED).toBe(-32004);
      expect(A2A_ERROR.INVALID_REQUEST).toBe(-32600);
      expect(A2A_ERROR.METHOD_NOT_FOUND).toBe(-32601);
      expect(A2A_ERROR.INTERNAL_ERROR).toBe(-32603);
    });

    it('error codes are negative integers', () => {
      for (const code of Object.values(A2A_ERROR)) {
        expect(code).toBeLessThan(0);
        expect(Number.isInteger(code)).toBe(true);
      }
    });
  });

  describe('type contracts', () => {
    it('A2AMessage with text part', () => {
      const msg: A2AMessage = {
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      };
      expect(msg.role).toBe('user');
      expect(msg.parts[0].type).toBe('text');
      expect((msg.parts[0] as TextPart).text).toBe('Hello');
    });

    it('A2AMessage with file part', () => {
      const msg: A2AMessage = {
        role: 'agent',
        parts: [
          {
            type: 'file',
            file: {
              name: 'doc.pdf',
              mimeType: 'application/pdf',
              bytes: 'dGVzdA==',
            },
          },
        ],
      };
      expect((msg.parts[0] as FilePart).file.name).toBe('doc.pdf');
    });

    it('A2AMessage with data part', () => {
      const msg: A2AMessage = {
        role: 'agent',
        parts: [
          {
            type: 'data',
            data: { key: 'value', count: 42 },
          },
        ],
      };
      expect((msg.parts[0] as DataPart).data.key).toBe('value');
    });

    it('Task has required fields', () => {
      const task: Task = {
        id: 'task-123',
        status: { state: 'submitted', timestamp: '2026-01-01T00:00:00Z' },
        messages: [],
      };
      expect(task.id).toBe('task-123');
      expect(task.status.state).toBe('submitted');
    });

    it('Task with artifacts', () => {
      const artifact: Artifact = {
        name: 'result',
        parts: [{ type: 'text', text: 'output' }],
        lastChunk: true,
      };
      const task: Task = {
        id: 't1',
        status: { state: 'completed', timestamp: '2026-01-01T00:00:00Z' },
        messages: [],
        artifacts: [artifact],
      };
      expect(task.artifacts).toHaveLength(1);
      expect(task.artifacts?.[0].lastChunk).toBe(true);
    });

    it('all TaskState values are valid strings', () => {
      const states: TaskState[] = [
        'submitted',
        'working',
        'input-required',
        'completed',
        'failed',
        'canceled',
      ];
      expect(states).toHaveLength(6);
      for (const s of states) {
        expect(typeof s).toBe('string');
      }
    });

    it('JsonRpcRequest has required fields', () => {
      const req: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'message/send',
        id: '1',
      };
      expect(req.jsonrpc).toBe('2.0');
      expect(req.method).toBe('message/send');
    });

    it('JsonRpcResponse with result', () => {
      const resp: JsonRpcResponse = {
        jsonrpc: '2.0',
        result: { id: 'task-1' },
        id: '1',
      };
      expect(resp.result).toBeDefined();
      expect(resp.error).toBeUndefined();
    });

    it('JsonRpcResponse with error', () => {
      const resp: JsonRpcResponse = {
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method not found' },
        id: '1',
      };
      expect(resp.error).toBeDefined();
      expect(resp.error?.code).toBe(-32601);
    });

    it('AgentCard has required structure', () => {
      const card: AgentCard = {
        name: 'TestAgent',
        description: 'A test agent',
        url: 'http://localhost:3000/a2a/test',
        version: '1.0.0',
        capabilities: { streaming: false },
        skills: [
          {
            id: 'skill1',
            name: 'Skill One',
            description: 'Does something',
          },
        ],
      };
      expect(card.name).toBe('TestAgent');
      expect(card.skills).toHaveLength(1);
    });
  });
});
