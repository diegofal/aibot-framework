import { A2AClient } from './client';
import type { AgentCard } from './types';

export class A2AClientPool {
  private clients = new Map<string, A2AClient>();

  addAgent(name: string, url: string, timeout?: number): A2AClient {
    const client = new A2AClient(url, timeout);
    this.clients.set(name, client);
    return client;
  }

  getClient(name: string): A2AClient | undefined {
    return this.clients.get(name);
  }

  removeAgent(name: string): void {
    this.clients.delete(name);
  }

  async discoverAll(): Promise<Map<string, AgentCard>> {
    const cards = new Map<string, AgentCard>();
    for (const [name, client] of this.clients) {
      try {
        cards.set(name, await client.getAgentCard());
      } catch {
        /* skip unreachable agents */
      }
    }
    return cards;
  }

  get size(): number {
    return this.clients.size;
  }
}
