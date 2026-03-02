import type { ThreadMessage } from '../types/thread';

export interface ProductionEvaluation {
  status?: 'approved' | 'rejected';
  rating?: number; // 1-5
  feedback?: string;
  evaluatedAt: string; // ISO
  aiResponse?: string;
  aiResponseAt?: string; // ISO
  thread?: ThreadMessage[];
}

export interface SummaryData {
  summary?: string;
  error?: string;
  generatedAt: string;
}

export interface TreeNode {
  name: string;
  path: string; // relative to productions/{botId}/
  type: 'dir' | 'file';
  children?: TreeNode[];
  size?: number;
  entryId?: string;
  evaluation?: { status?: string; rating?: number };
  description?: string;
}

export interface ProductionEntry {
  id: string;
  timestamp: string; // ISO
  botId: string;
  tool: string; // file_write | file_edit | exec
  path: string; // file path (relative to productions dir or basePath)
  action: 'create' | 'edit' | 'delete' | 'archive';
  description: string;
  size: number;
  trackOnly: boolean;
  archivedFrom?: string; // Original path before archiving
  archiveReason?: string; // Why it was archived
  evaluation?: ProductionEvaluation;
}
