import { describe, expect, it } from 'bun:test';
import {
  MCP_PROTOCOL_VERSION,
  _resetIdCounter,
  createJsonRpcErrorResponse,
  createJsonRpcNotification,
  createJsonRpcRequest,
  createJsonRpcResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from '../../src/mcp/types';

describe('MCP Types', () => {
  describe('MCP_PROTOCOL_VERSION', () => {
    it('should be the correct protocol version', () => {
      expect(MCP_PROTOCOL_VERSION).toBe('2024-11-05');
    });
  });

  describe('createJsonRpcRequest', () => {
    it('should create a valid JSON-RPC request with auto-incrementing ID', () => {
      _resetIdCounter();
      const req1 = createJsonRpcRequest('initialize', { foo: 'bar' });
      expect(req1.jsonrpc).toBe('2.0');
      expect(req1.id).toBe(1);
      expect(req1.method).toBe('initialize');
      expect(req1.params).toEqual({ foo: 'bar' });

      const req2 = createJsonRpcRequest('tools/list');
      expect(req2.id).toBe(2);
      expect(req2.params).toBeUndefined();
    });
  });

  describe('createJsonRpcNotification', () => {
    it('should create a notification without id', () => {
      const notif = createJsonRpcNotification('notifications/initialized');
      expect(notif.jsonrpc).toBe('2.0');
      expect(notif.method).toBe('notifications/initialized');
      expect('id' in notif).toBe(false);
    });
  });

  describe('createJsonRpcResponse', () => {
    it('should create a valid response', () => {
      const resp = createJsonRpcResponse(1, { tools: [] });
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.id).toBe(1);
      expect(resp.result).toEqual({ tools: [] });
      expect(resp.error).toBeUndefined();
    });

    it('should support null id', () => {
      const resp = createJsonRpcResponse(null, 'ok');
      expect(resp.id).toBeNull();
    });
  });

  describe('createJsonRpcErrorResponse', () => {
    it('should create an error response', () => {
      const resp = createJsonRpcErrorResponse(5, -32601, 'Method not found');
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.id).toBe(5);
      expect(resp.error).toEqual({ code: -32601, message: 'Method not found' });
      expect(resp.result).toBeUndefined();
    });
  });

  describe('isJsonRpcResponse', () => {
    it('should detect valid responses (with result)', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    });

    it('should detect valid responses (with error)', () => {
      expect(
        isJsonRpcResponse({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -1, message: 'fail' },
        })
      ).toBe(true);
    });

    it('should reject non-responses', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', method: 'foo', id: 1 })).toBe(false);
      expect(isJsonRpcResponse(null)).toBe(false);
      expect(isJsonRpcResponse('hello')).toBe(false);
      expect(isJsonRpcResponse(42)).toBe(false);
    });
  });

  describe('isJsonRpcRequest', () => {
    it('should detect valid requests', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toBe(
        true
      );
    });

    it('should reject responses and notifications', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
      expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'foo' })).toBe(false);
    });
  });
});
