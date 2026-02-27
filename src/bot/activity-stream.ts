import { EventEmitter } from 'events';

export type ActivityEventType =
  | 'tool:start'
  | 'tool:end'
  | 'tool:error'
  | 'llm:start'
  | 'llm:end'
  | 'agent:phase'
  | 'agent:idle'
  | 'agent:result'
  | 'memory:flush'
  | 'memory:rag'
  | 'collab:start'
  | 'collab:end';

export interface ActivityEvent {
  type: ActivityEventType;
  botId: string;
  timestamp: number;
  phase?: string;
  data?: Record<string, unknown>;
}

const DEFAULT_BUFFER_SIZE = 200;

export class ActivityStream extends EventEmitter {
  private buffer: ActivityEvent[] = [];
  private maxSize: number;

  constructor(maxSize: number = DEFAULT_BUFFER_SIZE) {
    super();
    this.maxSize = maxSize;
  }

  publish(event: ActivityEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
    this.emit('activity', event);
  }

  getRecent(count: number = 50): ActivityEvent[] {
    return this.buffer.slice(-count);
  }

  clear(): void {
    this.buffer = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}
