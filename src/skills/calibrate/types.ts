export type CalibrateScope = 'all' | 'identity' | 'soul' | 'motivations' | 'memory';

export interface Claim {
  text: string;
  /** User decision: correct / edit / remove / skip (pending = not yet reviewed) */
  verdict: 'pending' | 'correct' | 'edit' | 'remove' | 'skip';
  /** User-provided correction text (when verdict is 'edit') */
  correction?: string;
}

export interface ClaimBatch {
  title: string;
  sourceFile: string;
  claims: Claim[];
}

export type SessionPhase = 'extracting' | 'reviewing' | 'awaiting_edit' | 'rewriting' | 'confirming' | 'done';

export interface FileRewrite {
  filename: string;
  content: string;
}

export interface CalibrationSession {
  phase: SessionPhase;
  chatId: number;
  userId: number;
  scope: CalibrateScope;
  batches: ClaimBatch[];
  currentBatchIndex: number;
  /** Message ID of the current review prompt (for editing inline keyboard) */
  reviewMessageId?: number;
  /** Proposed file rewrites after LLM rewriting phase */
  rewrites: FileRewrite[];
  /** Timestamp of last interaction */
  lastActivity: number;
}

export interface CalibrateConfig {
  soulDir?: string;
  maxBatches?: number;
  sessionTimeoutMs?: number;
}

/** LLM extraction response shape */
export interface ExtractionResult {
  batches: {
    title: string;
    sourceFile: string;
    claims: string[];
  }[];
}

/** LLM rewrite response shape */
export interface RewriteResult {
  files: FileRewrite[];
}
