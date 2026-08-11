import type { Repository } from '@nocobase/database';
import type { Context } from '@nocobase/actions';
import { callExternalOcr, type OcrProviderConfig } from './external-ocr-client';
import type { AttachmentLike } from './internal-parser-registry';
import type { OcrEngineConfig } from './document-parse.types';

export class ExternalOcrEngine {
  readonly engine = 'external-ocr' as const;

  constructor(private readonly getProvidersRepo: () => Repository) {}

  async parseBuffer(
    _ctx: Context,
    buffer: Buffer,
    attachment: AttachmentLike,
    config: OcrEngineConfig,
    timeoutMs: number,
  ): Promise<string | null> {
    if (config.kind !== 'external-provider') {
      return null;
    }

    const provider = await this.getProvidersRepo().findOne({ filterByTk: config.providerId });
    if (!provider || !provider.get('enabled')) {
      return null;
    }

    const supportedMimetypes = provider.get('supportedMimetypes');
    if (
      Array.isArray(supportedMimetypes) &&
      supportedMimetypes.length > 0 &&
      attachment.mimetype &&
      !supportedMimetypes.includes(attachment.mimetype)
    ) {
      return null;
    }

    const requestFormat = provider.get('requestFormat') ?? 'multipart';
    if (requestFormat === 'url') {
      throw new Error('External OCR URL requests are not supported by the canonical pipeline.');
    }

    const text = await callExternalOcr(
      {
        apiEndpoint: provider.get('apiEndpoint'),
        authType: provider.get('authType'),
        apiKey: provider.get('apiKey'),
        authConfig: provider.get('authConfig') ?? {},
        requestFormat,
        requestConfig: provider.get('requestConfig') ?? {},
        responseTextPath: provider.get('responseTextPath') ?? 'text',
        timeout: Math.min(provider.get('timeout') ?? timeoutMs, timeoutMs),
      } satisfies OcrProviderConfig,
      {
        fileBuffer: buffer,
        filename: attachment.filename ?? attachment.name ?? 'file',
        mimetype: attachment.mimetype ?? 'application/octet-stream',
      },
    );

    return text.trim() || null;
  }
}
