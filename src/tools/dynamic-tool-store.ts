import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface DynamicToolMeta {
  id: string;
  name: string;
  description: string;
  type: 'typescript' | 'command';
  status: 'pending' | 'approved' | 'rejected';
  createdBy: string;
  scope: 'all' | string;  // 'all' or specific botId
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  createdAt: string;
  updatedAt: string;
  rejectionNote?: string;
}

export class DynamicToolStore {
  constructor(private storePath: string) {
    if (!existsSync(storePath)) {
      mkdirSync(storePath, { recursive: true });
    }
  }

  private toolDir(id: string): string {
    return join(this.storePath, id);
  }

  private metaPath(id: string): string {
    return join(this.toolDir(id), 'meta.json');
  }

  private sourcePath(id: string, type: 'typescript' | 'command'): string {
    return join(this.toolDir(id), type === 'typescript' ? 'tool.ts' : 'tool.sh');
  }

  list(): DynamicToolMeta[] {
    if (!existsSync(this.storePath)) return [];

    const entries = readdirSync(this.storePath, { withFileTypes: true });
    const metas: DynamicToolMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaFile = join(this.storePath, entry.name, 'meta.json');
      try {
        const raw = readFileSync(metaFile, 'utf-8');
        metas.push(JSON.parse(raw));
      } catch {
        // Skip invalid entries
      }
    }

    return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): { meta: DynamicToolMeta; source: string } | null {
    const metaFile = this.metaPath(id);
    if (!existsSync(metaFile)) return null;

    try {
      const meta: DynamicToolMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      const srcPath = this.sourcePath(id, meta.type);
      const source = existsSync(srcPath) ? readFileSync(srcPath, 'utf-8') : '';
      return { meta, source };
    } catch {
      return null;
    }
  }

  create(meta: Omit<DynamicToolMeta, 'id' | 'createdAt' | 'updatedAt' | 'status'>, source: string): DynamicToolMeta {
    const id = meta.name; // use snake_case name as id
    const dir = this.toolDir(id);

    if (existsSync(dir)) {
      throw new Error(`Tool "${id}" already exists`);
    }

    mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();
    const fullMeta: DynamicToolMeta = {
      ...meta,
      id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    writeFileSync(this.metaPath(id), JSON.stringify(fullMeta, null, 2), 'utf-8');
    writeFileSync(this.sourcePath(id, meta.type), source, 'utf-8');

    return fullMeta;
  }

  updateStatus(id: string, status: 'approved' | 'rejected', note?: string): DynamicToolMeta | null {
    const entry = this.get(id);
    if (!entry) return null;

    entry.meta.status = status;
    entry.meta.updatedAt = new Date().toISOString();
    if (note) entry.meta.rejectionNote = note;

    writeFileSync(this.metaPath(id), JSON.stringify(entry.meta, null, 2), 'utf-8');
    return entry.meta;
  }

  updateMeta(id: string, patch: Partial<Pick<DynamicToolMeta, 'name' | 'description' | 'scope' | 'parameters'>>): DynamicToolMeta | null {
    const entry = this.get(id);
    if (!entry) return null;

    if (patch.name !== undefined) entry.meta.name = patch.name;
    if (patch.description !== undefined) entry.meta.description = patch.description;
    if (patch.scope !== undefined) entry.meta.scope = patch.scope;
    if (patch.parameters !== undefined) entry.meta.parameters = patch.parameters;
    entry.meta.updatedAt = new Date().toISOString();

    writeFileSync(this.metaPath(id), JSON.stringify(entry.meta, null, 2), 'utf-8');
    return entry.meta;
  }

  delete(id: string): boolean {
    const dir = this.toolDir(id);
    if (!existsSync(dir)) return false;

    rmSync(dir, { recursive: true, force: true });
    return true;
  }
}
