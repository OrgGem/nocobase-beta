/**
 * UiPath Webhook Verifier
 *
 * Verifies incoming webhook payloads using HMAC-SHA256 signature
 * from the X-UiPath-Signature header.
 *
 * See: https://docs.uipath.com/automation-cloud/docs/about-webhooks
 */

import { createHmac, timingSafeEqual } from 'crypto';

export class UiPathWebhookVerifier {
  /**
   * Verify the HMAC-SHA256 signature of a UiPath webhook payload.
   *
   * @param secret - The webhook signing secret configured in the UiPath instance
   * @param signature - Value of the X-UiPath-Signature header
   * @param rawBody - Raw request body as string or Buffer
   * @returns true if signature matches
   */
  static verify(secret: string, signature: string, rawBody: string | Buffer): boolean {
    if (!secret || !signature || !rawBody) {
      return false;
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature.trim(), 'utf8');

    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }

  /**
   * Parse webhook event type from payload.
   * UiPath webhooks have a Type field like "job.faulted", "queueItem.transactionFailed", etc.
   */
  static parseEventType(payload: any): string {
    return payload?.Type || payload?.type || 'unknown';
  }

  /**
   * Extract entity key/id from webhook payload based on event type.
   */
  static extractEntityId(payload: any): string | null {
    // Jobs: payload contains Job object with Key
    if (payload?.Job?.Key) return payload.Job.Key;
    if (payload?.Job?.Id) return String(payload.Job.Id);
    // Queue items: payload contains QueueItem object
    if (payload?.QueueItem?.Id) return String(payload.QueueItem.Id);
    // Robots
    if (payload?.Robot?.Id) return String(payload.Robot.Id);
    // Generic
    if (payload?.EventId) return String(payload.EventId);
    return null;
  }
}
