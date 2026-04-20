/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { resolve, sep } from 'path';
import { readFile } from 'fs/promises';
import { Context } from '@nocobase/actions';
import axios from 'axios';

const APP_PUBLIC_PATH = (process.env.APP_PUBLIC_PATH || '/').replace(/\/+$/, '');
const STORAGE_ROOT = resolve(process.cwd());
import { InternalParserRegistry } from './services/internal-parser-registry';
import { BuiltinAIDocumentHandler } from './services/builtin-ai-handler';
import { BuiltinExcelHandler } from './services/builtin-excel-handler';
import { ParseRouter } from './services/parse-router';
import { testConnection, getSettings, saveSettings } from './resource/docParserProviders';
import type { AttachmentLike } from './services/internal-parser-registry';

export class PluginDocumentParserServer extends Plugin {
  /**
   * Public registry — other plugins register their format handlers here:
   *
   *   const docParser = this.pm.get(PluginDocumentParserServer);
   *   docParser.internalParserRegistry.register({ name, supports, parse });
   */
  readonly internalParserRegistry = new InternalParserRegistry();

  parseRouter!: ParseRouter;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async beforeLoad() {
    // Excel handler — higher priority than the AI loader (prepend: true)
    this.internalParserRegistry.register(new BuiltinExcelHandler(this.fetchFileBuffer.bind(this)), { prepend: true });

    // Built-in AI document handler (lowest priority — appended last)
    // Done in beforeLoad so other plugins' load() can prepend higher-priority handlers
    this.internalParserRegistry.register(
      new BuiltinAIDocumentHandler(() => {
        const aiPlugin = this.pm.get('@nocobase/plugin-ai') as any;
        return aiPlugin?.documentLoaders;
      }),
    );
  }

  async load() {
    // 1. Load collections
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    // 2. Wire up the parse router
    this.parseRouter = new ParseRouter(
      () => this.db.getRepository('docParserSettings'),
      () => this.db.getRepository('docParserProviders'),
      this.internalParserRegistry,
      this.fetchFileBuffer.bind(this),
      () => {
        const p = this.pm.get('@nocobase/plugin-docpixie') as any;
        return p?.service ? p : null;
      },
    );

    // 3. Patch AIManager to intercept parseAttachment on ALL providers
    this.wrapAIManager();

    // 4. Register resources
    this.app.resourceManager.define({
      name: 'docParserProviders',
      actions: {
        testConnection,
      },
    });

    this.app.resourceManager.define({
      name: 'docParserSettings',
      actions: {
        get: getSettings,
        save: saveSettings,
      },
    });

    // 5. ACL — only admins can manage settings & providers
    this.app.acl.registerSnippet({
      name: `pm.plugin-document-parser.providers`,
      actions: [
        'docParserProviders:list',
        'docParserProviders:create',
        'docParserProviders:update',
        'docParserProviders:destroy',
        'docParserProviders:get',
        'docParserProviders:testConnection',
      ],
    });
    this.app.acl.registerSnippet({
      name: `pm.plugin-document-parser.settings`,
      actions: ['docParserSettings:get', 'docParserSettings:save'],
    });
  }

  // ── AIManager patching ────────────────────────────────────────────────────

  /**
   * Wrap AIManager.registerLLMProvider so that every provider class — including
   * those registered AFTER this plugin loads (e.g. plugin-custom-llm) — gets
   * its `parseAttachment` intercepted.
   *
   * Additionally, iterate providers already registered (plugin-ai built-ins:
   * OpenAI, Anthropic, etc.) and wrap them immediately.
   */
  private wrapAIManager() {
    const aiPlugin = this.pm.get('@nocobase/plugin-ai') as any;
    if (!aiPlugin?.aiManager) {
      this.log.warn('[DocumentParser] plugin-ai not found — parseAttachment interception skipped');
      return;
    }

    const aiManager = aiPlugin.aiManager;
    const self = this;

    // Wrap the registration method (future registrations)
    const originalRegister = aiManager.registerLLMProvider.bind(aiManager);
    aiManager.registerLLMProvider = (name: string, meta: any) => {
      return originalRegister(name, { ...meta, provider: self.wrapProviderClass(meta.provider) });
    };

    // Wrap already-registered providers (built-ins)
    for (const [name, meta] of aiManager.llmProviders.entries()) {
      aiManager.llmProviders.set(name, { ...meta, provider: self.wrapProviderClass(meta.provider) });
    }

    this.log.info(`[DocumentParser] Wrapped ${aiManager.llmProviders.size} LLM providers`);
  }

  /**
   * Create a subclass of `OriginalProviderClass` that overrides `parseAttachment`
   * to go through our router first.  Uses `super.parseAttachment` as the default
   * parser fallback — this correctly handles providers that already override the
   * method (e.g. CustomLLMProvider, AnthropicProvider…).
   */
  private wrapProviderClass(OriginalClass: new (...args: any[]) => any) {
    const self = this;
    return class extends OriginalClass {
      async parseAttachment(ctx: Context, attachment: any) {
        return self.parseRouter.route(ctx, attachment, () => super.parseAttachment(ctx, attachment));
      }
    };
  }

  // ── File buffer helper ────────────────────────────────────────────────────

  /**
   * Fetch the raw bytes of an attachment using the file-manager plugin,
   * returning both the buffer and the resolved URL.
   *
   * Public so that other plugins (e.g. plugin-file-preview-auth) can reuse
   * this helper when implementing their own InternalParserHandler.
   */
  async fetchFileBuffer(ctx: Context, attachment: AttachmentLike): Promise<{ buffer: Buffer; url: string }> {
    const fileManager = this.app.pm.get('file-manager') as any;

    // Prefer streaming directly from storage when storageId is available.
    // This bypasses any HTTP auth layer (e.g. plugin-file-preview-auth) that
    // would cause a plain axios request to fail with 401/403.
    if (attachment.storageId) {
      try {
        const { stream } = await fileManager.getFileStream(attachment);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const buffer = Buffer.concat(chunks);
        // Resolve the URL separately for callers that need it (best-effort)
        let url = '';
        try {
          url = decodeURIComponent(await fileManager.getFileURL(attachment));
        } catch {
          // URL is informational only — don't fail if it can't be resolved
        }
        return { buffer, url };
      } catch (err) {
        this.log.warn(`[DocumentParser] getFileStream failed, falling back to URL fetch: ${err}`);
        // Fall through to URL-based fetch below
      }
    }

    const rawUrl: string = await fileManager.getFileURL(attachment);
    const url = decodeURIComponent(rawUrl);

    if (url.startsWith('http://') || url.startsWith('https://')) {
      assertNotPrivateUrl(url);
      const referer = ctx.get?.('referer') || '';
      const ua = ctx.get?.('user-agent') || '';
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        headers: { referer, 'User-Agent': ua },
      });
      return { buffer: Buffer.from(response.data), url };
    }

    // Local file — strip APP_PUBLIC_PATH before joining
    let localPath = url;
    if (APP_PUBLIC_PATH && localPath.startsWith(APP_PUBLIC_PATH + '/')) {
      localPath = localPath.slice(APP_PUBLIC_PATH.length);
    }

    const absPath = resolve(STORAGE_ROOT, localPath.replace(/^\//, ''));
    if (!absPath.startsWith(STORAGE_ROOT + sep)) {
      throw new Error(`[DocumentParser] Attachment path escapes storage root: ${localPath}`);
    }

    const buffer = await readFile(absPath);
    return { buffer, url };
  }
}

export default PluginDocumentParserServer;

// ─── SSRF guard ───────────────────────────────────────────────────────────────

/**
 * Reject URLs that resolve to private/loopback addresses to prevent SSRF attacks
 * against cloud metadata APIs (169.254.x.x) and internal services.
 */
function assertNotPrivateUrl(rawUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`[DocumentParser] Invalid URL: ${rawUrl}`);
  }

  // Strip IPv6 brackets
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  const BLOCKED = [
    /^localhost$/,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./, // AWS/GCP/Azure metadata
    /^::1$/, // IPv6 loopback
    /^fc[0-9a-f]{2}:/i, // IPv6 unique local
    /^fe80:/i, // IPv6 link-local
  ];

  if (BLOCKED.some((re) => re.test(hostname))) {
    throw new Error(`[DocumentParser] Blocked request to private/internal address: ${hostname}`);
  }
}
