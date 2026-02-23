export interface ThreadMessage {
  id: string;
  role: 'human' | 'bot';
  content: string;
  createdAt: string; // ISO
}
