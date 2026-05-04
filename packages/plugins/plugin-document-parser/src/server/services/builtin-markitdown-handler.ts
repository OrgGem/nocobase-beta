import { Context } from '@nocobase/actions';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { InternalParserHandler, InternalParseResult, AttachmentLike } from './internal-parser-registry';
import { resolveExtname } from './utils';

const execFileAsync = promisify(execFile);

const SUPPORTED_EXTNAMES = new Set(['.pdf', '.docx', '.pptx', '.html', '.htm', '.csv']);
const SUPPORTED_MIMETYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'text/html',
  'text/csv',
]);

/**
 * Built-in MarkItDown handler for plugin-document-parser.
 * Uses Microsoft's python markitdown CLI to parse PDF, DOCX, PPTX, HTML, CSV.
 */
export class BuiltinMarkitdownHandler implements InternalParserHandler {
  readonly name = 'builtin-markitdown-handler';

  constructor(
    private readonly getFileBuffer?: (
      ctx: Context,
      attachment: AttachmentLike,
    ) => Promise<{ buffer: Buffer; url: string }>,
    private readonly getSettingsRepo?: () => any,
  ) {}

  supports(attachment: AttachmentLike): boolean {
    if (attachment.mimetype && SUPPORTED_MIMETYPES.has(attachment.mimetype)) return true;
    return SUPPORTED_EXTNAMES.has(resolveExtname(attachment));
  }

  async parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult> {
    // Check if markitdown is enabled in settings
    if (this.getSettingsRepo) {
      try {
        const repo = this.getSettingsRepo();
        const settings = await repo.findOne();
        if (settings && settings.enableMarkitdown === false) {
          ctx.log?.info?.('[BuiltinMarkitdownHandler] Skipped: enableMarkitdown is false in settings');
          return { text: '', handled: false };
        }
      } catch (err) {
        ctx.log?.warn?.('[BuiltinMarkitdownHandler] Failed to fetch settings', err);
      }
    }

    const fetchFn = this.getFileBuffer;
    if (!fetchFn) {
      ctx.log?.warn?.('[BuiltinMarkitdownHandler] fetchFileBuffer not available');
      return { text: '', handled: false };
    }

    try {
      const { buffer } = await fetchFn(ctx, attachment);
      
      // Write buffer to temporary file
      const ext = resolveExtname(attachment) || '.tmp';
      const tmpFile = path.join(os.tmpdir(), `markitdown_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`);
      
      await fs.writeFile(tmpFile, buffer);

      try {
        // Execute markitdown CLI
        const { stdout } = await execFileAsync('markitdown', [tmpFile], { maxBuffer: 50 * 1024 * 1024 });
        
        return { text: stdout, handled: true };
      } finally {
        // Cleanup temporary file
        await fs.unlink(tmpFile).catch((err) => {
          ctx.log?.error?.(`[BuiltinMarkitdownHandler] Failed to delete temp file: ${tmpFile}`, err);
        });
      }
    } catch (err: any) {
      ctx.log?.error?.('[BuiltinMarkitdownHandler] Parsing failed', err);
      // Let it fall back to the AI handler or other handlers
      return { text: '', handled: false };
    }
  }
}
