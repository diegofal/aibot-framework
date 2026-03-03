import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface AdminCredentials {
  email: string;
  passwordHash: string;
  createdAt: string;
}

export class AdminCredentialStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'admin-credentials.json');
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  async create(email: string, password: string): Promise<void> {
    if (this.exists()) {
      throw new Error('Admin credentials already exist');
    }
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    const data: AdminCredentials = {
      email: email.toLowerCase(),
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  async verify(email: string, password: string): Promise<boolean> {
    if (!this.exists()) return false;
    try {
      const data: AdminCredentials = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (data.email !== email.toLowerCase()) return false;
      return Bun.password.verify(password, data.passwordHash);
    } catch {
      return false;
    }
  }
}
