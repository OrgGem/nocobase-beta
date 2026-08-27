/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Outbound webhook dispatcher for Knowledge Base lifecycle events
 * (document vectorization success/failure).
 *
 * Configuration via environment variables:
 *   KB_WEBHOOK_URL          — target endpoint; POST with JSON body. Empty = disabled.
 *   KB_WEBHOOK_SECRET       — optional shared secret, sent as `X-KB-Signature` header
 *                             (HMAC-SHA256 hex of the raw body when provided).
 *
 * Delivery is fire-and-forget with a short timeout: notification failures are
 * logged but never break document processing.
 */

import { createHmac } from 'crypto';

const WEBHOOK_TIMEOUT_MS = 10_000;

export type KbWebhookEvent = 'document.vectorized' | 'document.failed' | 'document.deleted';

export type KbWebhookPayload = {
  event: KbWebhookEvent;
  knowledgeBaseId?: string;
  documentId?: string;
  filename?: string;
  chunkCount?: number;
  error?: string;
  timestamp: string;
};

export class WebhookDispatcher {
  private getUrl(): string {
    return (process.env.KB_WEBHOOK_URL ?? '').trim();
  }

  isEnabled(): boolean {
    return this.getUrl().length > 0;
  }

  /**
   * Dispatch an event. Resolves to true when delivery succeeded (HTTP 2xx),
   * false otherwise. Never throws.
   */
  async dispatch(event: KbWebhookEvent, data: Omit<KbWebhookPayload, 'event' | 'timestamp'>): Promise<boolean> {
    const url = this.getUrl();
    if (!url) return false;

    const payload: KbWebhookPayload = {
      event,
      ...data,
      timestamp: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = process.env.KB_WEBHOOK_SECRET;
      if (secret) {
        headers['X-KB-Signature'] = createHmac('sha256', secret).update(body).digest('hex');
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
