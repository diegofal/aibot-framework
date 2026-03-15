import type { A2AMessage, AgentCard, JsonRpcRequest, JsonRpcResponse, Task } from './types';

export class A2AClient {
  private agentCard: AgentCard | null = null;

  constructor(
    private agentUrl: string,
    private timeout = 60_000
  ) {}

  async getAgentCard(): Promise<AgentCard> {
    if (this.agentCard) return this.agentCard;
    const resp = await fetch(`${this.agentUrl}/.well-known/agent.json`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(`Failed to fetch agent card: ${resp.status}`);
    this.agentCard = (await resp.json()) as AgentCard;
    return this.agentCard;
  }

  async sendMessage(message: A2AMessage, sessionId?: string): Promise<Task> {
    return this.rpcCall('message/send', { message, sessionId });
  }

  async getTask(taskId: string): Promise<Task> {
    return this.rpcCall('tasks/get', { id: taskId });
  }

  async cancelTask(taskId: string): Promise<Task> {
    return this.rpcCall('tasks/cancel', { id: taskId });
  }

  private async rpcCall(method: string, params: unknown): Promise<Task> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: crypto.randomUUID(),
    };

    const resp = await fetch(this.agentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!resp.ok) throw new Error(`A2A RPC failed: ${resp.status}`);

    const response = (await resp.json()) as JsonRpcResponse;
    if (response.error) {
      throw new Error(`A2A error ${response.error.code}: ${response.error.message}`);
    }

    return response.result as Task;
  }
}
