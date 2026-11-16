// SPDX-License-Identifier: Apache-2.0

/**
 * Build a Content-Disposition header value per RFC 6266 / RFC 5987.
 *
 * - `filename=` carries a plain ASCII fallback (quotes/backslashes/control
 *   chars stripped) so legacy clients still get a usable name.
 * - `filename*=UTF-8''...` carries the full UTF-8 encoded name so non-ASCII
 *   filenames (e.g. Vietnamese) survive on modern browsers.
 */
export function buildContentDisposition(filename: string, mode: 'inline' | 'attachment'): string {
  const dispositionType = mode === 'attachment' ? 'attachment' : 'inline';

  const asciiFallback =
    String(filename || 'file')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_') || 'file';
  // encodeURIComponent leaves !'()* unescaped; RFC 5987 wants them percent-encoded
  const encodedFilename = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '%20');

  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}
