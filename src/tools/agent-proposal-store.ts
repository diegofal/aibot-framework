import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentProposal {
  id: string;
  agentId: string;
  agentName: string;
  role: string;
  personalityDescription: string;
  skills: string[];
  justification: string;
  emoji?: string;
  language?: string;
  model?: string;
  llmBackend?: 'ollama' | 'claude-cli';
  agentLoop?: { mode?: 'periodic' | 'continuous'; every?: string };
  proposedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
  rejectionNote?: string;
  approvalResult?: {
    configCreated: boolean;
    soulGenerated: boolean;
    soulDir: string;
    error?: string;
  };
}

export class AgentProposalStore {
  constructor(private storePath: string) {
    if (!existsSync(storePath)) {
      mkdirSync(storePath, { recursive: true });
    }
  }

  private proposalDir(id: string): string {
    return join(this.storePath, id);
  }

  private metaPath(id: string): string {
    return join(this.proposalDir(id), 'meta.json');
  }

  list(): AgentProposal[] {
    if (!existsSync(this.storePath)) return [];

    const entries = readdirSync(this.storePath, { withFileTypes: true });
    const proposals: AgentProposal[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaFile = join(this.storePath, entry.name, 'meta.json');
      try {
        const raw = readFileSync(metaFile, 'utf-8');
        proposals.push(JSON.parse(raw));
      } catch {
        // Skip invalid entries
      }
    }

    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): AgentProposal | null {
    const metaFile = this.metaPath(id);
    if (!existsSync(metaFile)) return null;

    try {
      return JSON.parse(readFileSync(metaFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  create(data: Omit<AgentProposal, 'id' | 'createdAt' | 'updatedAt' | 'status'>): AgentProposal {
    const id = randomUUID();
    const dir = this.proposalDir(id);
    mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();
    const proposal: AgentProposal = {
      ...data,
      id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    writeFileSync(this.metaPath(id), JSON.stringify(proposal, null, 2), 'utf-8');
    return proposal;
  }

  updateStatus(id: string, status: 'approved' | 'rejected', note?: string): AgentProposal | null {
    const proposal = this.get(id);
    if (!proposal) return null;

    proposal.status = status;
    proposal.updatedAt = new Date().toISOString();
    if (note) proposal.rejectionNote = note;

    writeFileSync(this.metaPath(id), JSON.stringify(proposal, null, 2), 'utf-8');
    return proposal;
  }

  updateApprovalResult(id: string, result: AgentProposal['approvalResult']): AgentProposal | null {
    const proposal = this.get(id);
    if (!proposal) return null;

    proposal.approvalResult = result;
    proposal.updatedAt = new Date().toISOString();

    writeFileSync(this.metaPath(id), JSON.stringify(proposal, null, 2), 'utf-8');
    return proposal;
  }

  delete(id: string): boolean {
    const dir = this.proposalDir(id);
    if (!existsSync(dir)) return false;

    rmSync(dir, { recursive: true, force: true });
    return true;
  }
}
