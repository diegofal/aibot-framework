export interface MemoryChunk {
  id?: number;
  fileId: number;
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
  tokenEstimate: number;
  contentHash: string;
  embedding?: number[];
}

export interface MemoryFile {
  id?: number;
  path: string;
  contentHash: string;
  lastIndexedAt: string;
  chunkCount: number;
}

export interface MemorySearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  source: 'vector' | 'keyword' | 'both';
}

export interface RawChunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenEstimate: number;
  contentHash: string;
}
