import type { Context } from '@nocobase/actions';

export type AttachmentLike = {
  id?: string | number;
  filename?: string;
  name?: string;
  mimetype?: string;
  extname?: string;
  url?: string;
  storageId?: number;
  size?: number;
  meta?: Record<string, any>;
  [key: string]: any;
};

export type InternalParseResult = {
  text: string;
  handled: boolean;
};

export interface InternalParserHandler {
  name: string;
  supports(attachment: AttachmentLike): boolean;
  parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult>;
}

export type MarkItDownRuntimeInfo = {
  command: string;
  baseArgs: string[];
  builtinSourcePath: string;
  builtinRunnerPath: string;
  enablePlugins: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  supportedExtnames: string[];
};

export type MarkItDownCheckResult = MarkItDownRuntimeInfo & {
  available: boolean;
  message: string;
};
