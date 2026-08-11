import type { Context } from '@nocobase/actions';

export type FileSearchSettings = {
  singletonKey?: string;
  enabled: boolean;
  autoIndex: boolean;
  enableAiTool: boolean;
  parserStrategy: 'document-parser' | 'direct';
  llmService?: string | null;
  indexModel?: string | null;
  retrieveModel?: string | null;
  pageIndexWorkspace: string;
  pageIndexPythonCommand: string;
  maxFileSizeMb: number;
  allowedExtnames: string[];
  concurrency: number;
  timeoutMs: number;
};

export type AttachmentLike = {
  id?: string | number;
  filename?: string;
  name?: string;
  mimetype?: string;
  extname?: string;
  url?: string;
  storageId?: number | string;
  size?: number;
  [key: string]: unknown;
};

export type ExtractedDocument = {
  filePath: string;
  cleanup: () => Promise<void>;
  checksum: string;
  mode: 'pdf' | 'md';
};

export type FileSearchResult = {
  documentId: number;
  fileId: number | string;
  fileCollection: string;
  filename: string;
  mimetype?: string;
  pageIndexDocId: string;
  title?: string;
  snippet: string;
  page?: number;
  nodeId?: string;
  score?: number;
  references: Array<{
    ownerCollection: string;
    ownerRecordId: number | string;
    ownerField?: string;
  }>;
  previewUrl?: string;
  downloadUrl?: string;
};

export type ActionHandler = (ctx: Context, next: () => Promise<void>) => Promise<void>;
