import type { NormalizedOcrItem, VerifyPayloadInput } from '../shared/types';

export type OcrItem = Omit<NormalizedOcrItem, 'value'> & { value: unknown };
export type OcrBlockProps = Partial<VerifyPayloadInput> & { sourceMode?: 'currentRecord' | 'manualRecord' };
export type OcrSettings = {
  pdfjsCdnUrl?: string;
  pdfjsWorkerUrl?: string;
  callbackUrl?: string;
  callbackApiKey?: string;
  callbackTimeoutMs?: number;
  acceptStatus?: string;
  rejectStatus?: string;
  autoSave?: boolean;
};
export type OcrPayload = {
  data?: unknown;
  items?: OcrItem[];
  pdfUrl?: string;
  attachmentId?: string | number;
  ocrStatus?: string;
  ocrError?: string | null;
};
export type OcrStatus = { status?: string; error?: string | null };
export type OcrMonitorRow = {
  id: string | number;
  attachmentId: string | number;
  status?: string;
  error?: string;
  createdAt?: string;
  attachment?: { filename?: string; size?: number; mimetype?: string };
};
