export interface FileRef {
  path: string; // Relative to bot's workDir
  size?: number; // Bytes
}

export interface DocumentRef {
  name: string;
  mimeType: string;
  size?: number; // Bytes
}

export interface ApprovalRequest {
  toolName: string;
  description: string; // human-readable from describeToolCall()
  status: 'pending' | 'approved' | 'denied';
  args?: Record<string, unknown>; // tool arguments, persisted as fallback for approval after restart
}

export interface ThreadMessage {
  id: string;
  role: 'human' | 'bot';
  content: string;
  files?: FileRef[];
  images?: string[]; // base64-encoded images
  documents?: DocumentRef[]; // attached document metadata (content is in message text)
  approval?: ApprovalRequest;
  createdAt: string; // ISO
}
