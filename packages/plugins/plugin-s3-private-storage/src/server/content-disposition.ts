/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Build a Content-Disposition header value per RFC 6266.
 *
 * - `filename=` carries a plain ASCII fallback (quotes/backslashes/control
 *   chars stripped) so legacy clients still get a usable name.
 * - `filename*=UTF-8''...` carries the full UTF-8 encoded name.
 */
export function buildContentDisposition(filename: string, mode: 'inline' | 'attachment'): string {
  const dispositionType = mode === 'attachment' ? 'attachment' : 'inline';

  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  // encodeURIComponent leaves !'()* unescaped; RFC 5987 wants them percent-encoded
  const encodedFilename = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}
