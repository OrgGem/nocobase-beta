import { buildContentDisposition } from '../content-disposition';

describe('buildContentDisposition', () => {
  it('produces attachment with ASCII fallback and UTF-8 filename*', () => {
    const value = buildContentDisposition('báo cáo tháng.txt', 'attachment');
    expect(value).toMatch(/^attachment; /);
    expect(value).toMatch(/filename="[^"]*"/);
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent('báo cáo tháng.txt'));
    // ASCII fallback strips non-ASCII chars
    const fallback = value.match(/filename="([^"]*)"/)?.[1] || '';
    expect(fallback).toMatch(/^[\x20-\x7E]+$/);
  });

  it('produces inline disposition for preview mode', () => {
    const value = buildContentDisposition('report.pdf', 'inline');
    expect(value).toMatch(/^inline; /);
  });

  it('percent-encodes RFC 5987 special characters', () => {
    const value = buildContentDisposition("a'b(c).txt", 'attachment');
    // ' ( ) must be percent-encoded in filename*
    expect(value).toContain('a%27b%28c%29.txt');
  });

  it('replaces quotes and backslashes in the ASCII fallback', () => {
    const value = buildContentDisposition('we"ird\\name.txt', 'attachment');
    const fallback = value.match(/filename="([^"]*)"/)?.[1] || '';
    expect(fallback).not.toContain('"');
    expect(fallback).not.toContain('\\');
  });

  it('replaces quotes with underscores so the fallback stays printable', () => {
    const value = buildContentDisposition('"""', 'attachment');
    expect(value).toContain('filename="___"');
  });

  it('falls back to "file" when the name is empty', () => {
    const value = buildContentDisposition('', 'attachment');
    expect(value).toContain('filename="file"');
  });
});
