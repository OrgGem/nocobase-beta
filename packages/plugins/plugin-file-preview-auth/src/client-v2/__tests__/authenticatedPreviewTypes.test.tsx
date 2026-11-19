// SPDX-License-Identifier: Apache-2.0

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

vi.mock('@nocobase/plugin-file-manager/client-v2', () => ({
  filePreviewTypes: { add: vi.fn() },
}));

vi.mock('../AIFilePreviewAction', () => ({
  default: () => null,
}));

import { createLruBlobCache, toPdfBlob } from '../../shared/previewHelpers';
import {
  AuthXlsxInlinePreviewer,
  buildAuthenticatedDownloadUrl,
  getLoadedFileBlob,
  isDocxFile,
  isPptxFile,
  resetBlobCacheForTest,
} from '../authenticatedPreviewTypes';

afterEach(() => {
  cleanup();
  resetBlobCacheForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('client-v2 authenticatedPreviewTypes', () => {
  it('preserves internal authenticated API URLs instead of double-wrapping them', () => {
    expect(buildAuthenticatedDownloadUrl({ url: '/api/skillHub:download?execId=7&f=abc' }, 'inline')).toBe(
      '/api/skillHub:download?execId=7&f=abc',
    );
    expect(buildAuthenticatedDownloadUrl({ url: '/api/attachments:stream?filterByTk=12' }, 'inline')).toBe(
      '/api/attachments:stream?filterByTk=12',
    );
    expect(
      buildAuthenticatedDownloadUrl({ url: '/api/filePreviewAuth:download?id=9&collection=attachments' }, 'inline'),
    ).toBe('/api/filePreviewAuth:download?id=9&collection=attachments');
  });

  it('matches only OOXML docx/pptx files and leaves legacy doc/ppt to download fallback', () => {
    expect(isDocxFile({ filename: 'spec.docx' })).toBe(true);
    expect(isDocxFile({ filename: 'legacy.doc' })).toBe(false);
    expect(isPptxFile({ filename: 'deck.pptx' })).toBe(true);
    expect(isPptxFile({ filename: 'legacy.ppt' })).toBe(false);
  });

  it('evicts failed blob fetches so subsequent retries succeed', async () => {
    const okBlob = new Blob(['ok'], { type: 'text/plain' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, blob: async () => okBlob });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getLoadedFileBlob({ id: 1, url: '/uploads/a.txt', filename: 'a.txt' })).rejects.toThrow('HTTP 502');
    const blob = await getLoadedFileBlob({ id: 1, url: '/uploads/a.txt', filename: 'a.txt' });
    expect(blob).toBe(okBlob);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enforces LRU size cap and clears cache on token change', async () => {
    const cache = createLruBlobCache(2);
    const loader = vi.fn(async () => new Blob(['x']));

    await cache.getOrLoad('token-a', 'k1', loader);
    await cache.getOrLoad('token-a', 'k2', loader);
    await cache.getOrLoad('token-a', 'k3', loader);
    expect(cache.size()).toBe(2);

    await cache.getOrLoad('token-b', 'k4', loader);
    expect(cache.size()).toBe(1);
  });

  it('forces application/pdf MIME type on PDF preview blobs to block same-origin HTML execution', () => {
    const htmlBlob = new Blob(['<script>alert(1)</script>'], { type: 'text/html' });
    const pdfBlob = toPdfBlob(htmlBlob);
    expect(pdfBlob.type).toBe('application/pdf');
  });

  it('renders XLSX spreadsheets as escaped React table cells without javascript: links', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Title', 'Formula'],
      ['click me', '<img src=x onerror=alert(1)>'],
    ]);
    sheet['A2'].l = { Target: 'javascript:alert(1)' };
    const workbook = { SheetNames: ['Sheet1'], Sheets: { Sheet1: sheet } };
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const blob = Object.assign(
      new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      { arrayBuffer: async () => bytes },
    );

    const { container } = render(
      <AuthXlsxInlinePreviewer
        file={{ filename: 'report.xlsx', originFileObj: blob }}
        index={0}
        list={[]}
        onDownload={vi.fn()}
      />,
    );

    expect(await screen.findByText('click me')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});
