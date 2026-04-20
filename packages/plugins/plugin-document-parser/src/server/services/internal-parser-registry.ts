/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';

// ─── Public contract ──────────────────────────────────────────────────────────

export type InternalParseResult = {
  /** Extracted plain text content */
  text: string;
  /** True when this handler actually processed the file (not skipped/unsupported) */
  handled: boolean;
};

/**
 * Contract every internal parser handler must satisfy.
 *
 * Other plugins register handlers via:
 *   plugin.internalParserRegistry.register(myHandler)
 *
 * Handlers are tried in registration order.  The first one that returns
 * `handled: true` wins; the rest are skipped.  This lets specialised handlers
 * (e.g. a dedicated Excel parser plugin) take priority over the generic
 * fallback handler.
 */
export interface InternalParserHandler {
  /** Unique name used for logging / debugging */
  name: string;

  /**
   * Return true if this handler CAN process the given attachment.
   * Called before `parse()` to avoid unnecessary work.
   */
  supports(attachment: AttachmentLike): boolean;

  /**
   * Parse the attachment and return extracted text.
   * Throw if parsing fails — the registry will either propagate the error
   * or let the router fall back to default, depending on settings.
   */
  parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult>;
}

/** Minimal shape of an attachment object passed through the system */
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

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Central registry for internal document parser handlers.
 *
 * Handlers are called in the order they were registered.
 * The first handler that declares `supports() = true` processes the file.
 *
 * Usage (from another plugin):
 *
 *   const docParser = this.pm.get(PluginDocumentParserServer);
 *   docParser.internalParserRegistry.register({
 *     name: 'my-excel-parser',
 *     supports: (att) => att.mimetype === 'application/vnd.openxmlformats...',
 *     async parse(att, ctx) {
 *       const text = await myExcelToText(att);
 *       return { text, handled: true };
 *     },
 *   });
 */
export class InternalParserRegistry {
  private handlers: InternalParserHandler[] = [];

  /**
   * Register a new handler.
   * Pass `{ prepend: true }` to insert at the front so it takes priority
   * over previously registered handlers (useful for specialised format plugins).
   */
  register(handler: InternalParserHandler, options?: { prepend?: boolean }): void {
    if (this.handlers.find((h) => h.name === handler.name)) {
      throw new Error(`[DocumentParser] Handler "${handler.name}" is already registered.`);
    }
    if (options?.prepend) {
      this.handlers.unshift(handler);
    } else {
      this.handlers.push(handler);
    }
  }

  /** Remove a previously registered handler by name */
  unregister(name: string): void {
    this.handlers = this.handlers.filter((h) => h.name !== name);
  }

  /** Return a copy of the current handler list (for introspection / tests) */
  list(): ReadonlyArray<InternalParserHandler> {
    return [...this.handlers];
  }

  /**
   * Try handlers in order; return the result of the first one that
   * `supports` and successfully `parse`s the attachment.
   *
   * Returns `{ text: '', handled: false }` when no handler supports the file.
   */
  async parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult> {
    for (const handler of this.handlers) {
      if (!handler.supports(attachment)) {
        continue;
      }
      const result = await handler.parse(attachment, ctx);
      if (result.handled) {
        return result;
      }
    }
    return { text: '', handled: false };
  }

  get size(): number {
    return this.handlers.length;
  }
}
