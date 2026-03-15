/**
 * A2A Protocol v0.3.0 Types
 * Agent-to-Agent communication protocol types.
 */

// --- Agent Card ---
export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  inputModes?: string[];
  outputModes?: string[];
  tags?: string[];
}

// --- Message ---
export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
}

export type A2APart = TextPart | FilePart | DataPart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface FilePart {
  type: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export interface DataPart {
  type: 'data';
  data: Record<string, unknown>;
}

// --- Task ---
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface Task {
  id: string;
  sessionId?: string;
  status: TaskStatus;
  messages: A2AMessage[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  timestamp: string;
}

export interface Artifact {
  name?: string;
  description?: string;
  parts: A2APart[];
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
}

// --- JSON-RPC ---
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// A2A error codes
export const A2A_ERROR = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  CONTENT_TYPE_NOT_SUPPORTED: -32004,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
} as const;

// --- Method params ---
export interface MessageSendParams {
  message: A2AMessage;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskGetParams {
  id: string;
}

export interface TaskCancelParams {
  id: string;
}
