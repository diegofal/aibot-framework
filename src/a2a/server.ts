import type { Hono } from 'hono';
import type { Logger } from '../logger';
import { type AgentCardOptions, buildAgentCard } from './agent-card-builder';
import { AgentDirectory, type DirectoryConfig } from './directory';
import { type ExecutorDeps, executeA2AMessage } from './executor';
import { TaskStore } from './task-store';
import type {
  AgentCard,
  JsonRpcRequest,
  JsonRpcResponse,
  MessageSendParams,
  TaskCancelParams,
  TaskGetParams,
} from './types';
import { A2A_ERROR as ERR } from './types';

export interface A2AServerConfig {
  basePath?: string;
  maxTasks?: number;
  taskTtlMs?: number;
  directory?: DirectoryConfig;
}

export class A2AServer {
  private taskStore: TaskStore;
  readonly directory: AgentDirectory;

  constructor(
    private botIds: string[],
    private getCardOptions: (botId: string) => AgentCardOptions | null,
    private executorDeps: ExecutorDeps,
    private logger: Logger,
    config?: A2AServerConfig
  ) {
    this.taskStore = new TaskStore({
      maxTasks: config?.maxTasks ?? 1000,
      ttlMs: config?.taskTtlMs ?? 3_600_000,
    });
    this.directory = new AgentDirectory(config?.directory);
  }

  mount(app: Hono, basePath = '/a2a'): void {
    // Agent card discovery
    app.get(`${basePath}/:botId/.well-known/agent.json`, (c) => {
      const botId = c.req.param('botId');
      const opts = this.getCardOptions(botId);
      if (!opts) return c.json({ error: 'Agent not found' }, 404);
      return c.json(buildAgentCard(opts));
    });

    // JSON-RPC endpoint
    app.post(`${basePath}/:botId`, async (c) => {
      const botId = c.req.param('botId');
      const opts = this.getCardOptions(botId);
      if (!opts) return c.json(this.rpcError(null, ERR.INVALID_REQUEST, 'Agent not found'), 404);

      let request: JsonRpcRequest;
      try {
        request = await c.req.json();
      } catch {
        return c.json(this.rpcError(null, ERR.INVALID_REQUEST, 'Invalid JSON'), 400);
      }

      if (request.jsonrpc !== '2.0') {
        return c.json(
          this.rpcError(request.id, ERR.INVALID_REQUEST, 'Invalid JSON-RPC version'),
          400
        );
      }

      const response = await this.handleMethod(botId, request);
      return c.json(response);
    });

    // --- Directory endpoints ---

    app.post(`${basePath}/directory/register`, async (c) => {
      const card = (await c.req.json()) as AgentCard;
      if (!card.name || !card.url) return c.json({ error: 'Missing name or url' }, 400);
      const entry = this.directory.register(card);
      return c.json({ registered: true, name: card.name, registeredAt: entry.registeredAt });
    });

    app.post(`${basePath}/directory/heartbeat`, async (c) => {
      const { name } = (await c.req.json()) as { name: string };
      const ok = this.directory.heartbeat(name);
      return c.json({ ok });
    });

    app.get(`${basePath}/directory/agents`, (c) => {
      const q = c.req.query('q');
      const healthyOnly = c.req.query('healthy') === 'true';
      const entries = q ? this.directory.searchBySkill(q) : this.directory.list(healthyOnly);
      return c.json(
        entries.map((e) => ({
          name: e.card.name,
          description: e.card.description,
          url: e.card.url,
          skills: e.card.skills.length,
          healthy: e.healthy,
          lastHeartbeat: e.lastHeartbeat,
        }))
      );
    });

    app.delete(`${basePath}/directory/agents/:name`, (c) => {
      const name = c.req.param('name');
      const ok = this.directory.unregister(name);
      return c.json({ ok });
    });
  }

  private async handleMethod(botId: string, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (req.method) {
      case 'message/send':
        return this.handleMessageSend(botId, req);
      case 'tasks/get':
        return this.handleTaskGet(req);
      case 'tasks/cancel':
        return this.handleTaskCancel(req);
      default:
        return this.rpcError(req.id, ERR.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
    }
  }

  private async handleMessageSend(botId: string, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params as MessageSendParams;
    if (!params?.message) {
      return this.rpcError(req.id, ERR.INVALID_REQUEST, 'Missing message');
    }

    const taskId = crypto.randomUUID();
    const task = this.taskStore.create(taskId, params.message, params.sessionId);

    // Update to working
    this.taskStore.updateState(taskId, 'working');

    try {
      // Get all messages for this session if continuing
      const sessionMessages = params.sessionId
        ? this.taskStore.listBySession(params.sessionId).flatMap((t) => t.messages)
        : [params.message];

      const response = await executeA2AMessage(botId, sessionMessages, this.executorDeps);

      this.taskStore.updateState(taskId, 'completed', response);
      this.taskStore.addArtifact(taskId, {
        parts: response.parts,
        lastChunk: true,
      });

      return this.rpcSuccess(req.id, this.taskStore.get(taskId));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, taskId, botId }, 'A2A: message/send failed');

      this.taskStore.updateState(taskId, 'failed', {
        role: 'agent',
        parts: [{ type: 'text', text: `Error: ${errMsg}` }],
      });

      return this.rpcError(req.id, ERR.INTERNAL_ERROR, errMsg);
    }
  }

  private handleTaskGet(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as TaskGetParams;
    if (!params?.id) return this.rpcError(req.id, ERR.INVALID_REQUEST, 'Missing task id');

    const task = this.taskStore.get(params.id);
    if (!task) return this.rpcError(req.id, ERR.TASK_NOT_FOUND, 'Task not found');

    return this.rpcSuccess(req.id, task);
  }

  private handleTaskCancel(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as TaskCancelParams;
    if (!params?.id) return this.rpcError(req.id, ERR.INVALID_REQUEST, 'Missing task id');

    const task = this.taskStore.get(params.id);
    if (!task) return this.rpcError(req.id, ERR.TASK_NOT_FOUND, 'Task not found');

    if (!this.taskStore.cancel(params.id)) {
      return this.rpcError(req.id, ERR.TASK_NOT_CANCELABLE, 'Task cannot be canceled');
    }

    return this.rpcSuccess(req.id, this.taskStore.get(params.id));
  }

  private rpcSuccess(id: string | number, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', result, id };
  }

  private rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', error: { code, message }, id };
  }

  destroy(): void {
    this.taskStore.destroy();
    this.directory.destroy();
  }
}
