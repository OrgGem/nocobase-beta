import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import type { CarboneOutputFormat } from '../../shared/constants';

export interface CarboneClientConfig {
  endpoint: string;
  apiToken?: string;
  carboneVersion: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface CarboneRenderOptions {
  data: unknown;
  convertTo?: CarboneOutputFormat | { formatName: CarboneOutputFormat; formatOptions?: unknown };
  reportName?: string;
  variableStr?: string;
  enum?: Record<string, unknown>;
  translations?: Record<string, unknown>;
  lang?: string;
  timezone?: string;
  complement?: unknown;
}

export interface CarboneRenderResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Thin wrapper around the Carbone.io REST API.
 *
 *   POST   /template                      → upload a template, returns SHA-256 templateId
 *   DELETE /template/:templateId          → remove a template
 *   GET    /template/:templateId          → download a template
 *   POST   /render/:templateId            → render with JSON data, returns renderId
 *   GET    /render/:renderId              → download the rendered file
 *   GET    /status                        → server health check
 *
 * Calls are retried (exponential backoff) on transient network errors and 5xx
 * responses. Auth via Bearer token + `carbone-version` header.
 */
export class CarboneClient {
  private readonly http: AxiosInstance;

  constructor(private readonly cfg: CarboneClientConfig) {
    this.http = axios.create({
      baseURL: cfg.endpoint.replace(/\/+$/, ''),
      timeout: cfg.timeoutMs,
      headers: {
        'carbone-version': cfg.carboneVersion,
        ...(cfg.apiToken ? { Authorization: `Bearer ${cfg.apiToken}` } : {}),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  }

  async status(): Promise<unknown> {
    const { data } = await this.withRetry(() => this.http.get('/status'));
    return data;
  }

  async uploadTemplate(buffer: Buffer, filename = 'template.docx', payload?: string): Promise<string> {
    const form = new FormData();
    form.append('template', buffer, { filename });
    if (payload) form.append('payload', payload);
    const { data } = await this.withRetry(() =>
      this.http.post('/template', form, { headers: form.getHeaders() }),
    );
    const templateId = data?.data?.templateId ?? data?.templateId;
    if (!templateId) throw new Error('Carbone /template did not return a templateId');
    return templateId;
  }

  async deleteTemplate(templateId: string): Promise<void> {
    await this.withRetry(() => this.http.delete(`/template/${templateId}`));
  }

  /**
   * Check whether Carbone still has a templateId. The community edition LRU
   * may evict entries; callers use this to decide whether to re-upload.
   */
  async templateExists(templateId: string): Promise<boolean> {
    try {
      await this.withRetry(() =>
        this.http.get(`/template/${templateId}`, { responseType: 'arraybuffer' }),
      );
      return true;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) return false;
      throw err;
    }
  }

  async render(templateId: string, options: CarboneRenderOptions): Promise<CarboneRenderResult> {
    const { data: postData } = await this.withRetry(() =>
      this.http.post(`/render/${templateId}`, options),
    );
    const renderId = postData?.data?.renderId ?? postData?.renderId;
    if (!renderId) throw new Error('Carbone /render did not return a renderId');

    const { data: fileData, headers } = await this.withRetry(() =>
      this.http.get(`/render/${renderId}`, { responseType: 'arraybuffer' }),
    );
    return {
      buffer: Buffer.from(fileData as ArrayBuffer),
      filename: this.parseFilename(headers['content-disposition']) ?? renderId,
      mimeType: (headers['content-type'] as string) ?? 'application/octet-stream',
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const status = err?.response?.status;
        const retriable = !status || status >= 500;
        if (!retriable || attempt === this.cfg.maxRetries) break;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  private parseFilename(disposition?: string): string | undefined {
    if (!disposition) return undefined;
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return match?.[1];
  }
}
