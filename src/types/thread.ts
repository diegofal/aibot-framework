export interface FileRef {
  path: string; // Relative to bot's workDir
  size?: number; // Bytes
}

export interface ThreadMessage {
  id: string;
  role: 'human' | 'bot';
  content: string;
  files?: FileRef[];
  createdAt: string; // ISO
}
