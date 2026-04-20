/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { AttachmentLike } from './internal-parser-registry';

/**
 * Resolve the file extension from an attachment object.
 * Tries `attachment.extname` first, then extracts from the filename.
 * Returns lowercase extension with leading dot (e.g. `.pdf`) or empty string.
 */
export function resolveExtname(attachment: AttachmentLike): string {
  if (attachment.extname) return attachment.extname.toLowerCase();
  const name = attachment.filename ?? attachment.name ?? '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

/**
 * Sanitize a string for safe inclusion inside XML-like attribute values.
 * Escapes `"`, `<`, `>`, and `&` characters.
 */
export function sanitizeForXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
