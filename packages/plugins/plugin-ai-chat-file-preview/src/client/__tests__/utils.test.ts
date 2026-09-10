import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => ({ request: vi.fn(), resource: vi.fn() }),
  attachmentFileTypes: { getTypeByFile: () => undefined },
}));

vi.mock('@nocobase/plugin-ai/client-v2', () => ({
  getGlobalChatBoxRuntime: vi.fn(),
}));

import { getGlobalChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import {
  stripFilenameNoise,
  extractFilenameFromText,
  getDisplayNameCandidates,
  isKnownFileUrl,
  buildSkillHubManifestMap,
  findManifestEntryForName,
  readActiveSession,
} from '../ChatFilePreviewProvider';

const mockedGetRuntime = vi.mocked(getGlobalChatBoxRuntime);

describe('AI Chat File Preview client utils', () => {
  describe('stripFilenameNoise', () => {
    it('should strip quotes and braces', () => {
      expect(stripFilenameNoise('"test.docx"')).toBe('test.docx');
      expect(stripFilenameNoise("'test.pdf'")).toBe('test.pdf');
      expect(stripFilenameNoise('(test.xlsx)')).toBe('test.xlsx');
      expect(stripFilenameNoise('[test.csv]')).toBe('test.csv');
      expect(stripFilenameNoise('  test.txt  ')).toBe('test.txt');
    });

    it('should handle clean strings without noise', () => {
      expect(stripFilenameNoise('clean_name.doc')).toBe('clean_name.doc');
    });
  });

  describe('extractFilenameFromText', () => {
    it('should extract files from paths or text content', () => {
      expect(extractFilenameFromText('Some text with a file name test.docx inside it')).toBe('test.docx');
      expect(extractFilenameFromText('/path/to/my-sheet.xlsx')).toBe('/path/to/my-sheet.xlsx');
      expect(extractFilenameFromText('download "data.csv"')).toBe('data.csv');
    });

    it('should fall back to cleaned text when no matching extension', () => {
      expect(extractFilenameFromText('unregistered_extension.abc')).toBe('unregistered_extension.abc');
    });
  });

  describe('getDisplayNameCandidates', () => {
    it('should return candidate names for matching', () => {
      const candidates = getDisplayNameCandidates('  "report.xlsx" ');
      expect(candidates).toContain('report.xlsx');
    });
  });

  describe('isKnownFileUrl', () => {
    it('should identify system file urls', () => {
      expect(isKnownFileUrl('/api/attachments/123')).toBe(true);
      expect(isKnownFileUrl('/api/files/download/abc')).toBe(true);
      expect(isKnownFileUrl('https://my-bucket.s3.amazonaws.com/file.pdf')).toBe(true);
    });

    it('should return false for unrelated urls', () => {
      expect(isKnownFileUrl('https://google.com')).toBe(false);
      expect(isKnownFileUrl('')).toBe(false);
      expect(isKnownFileUrl(undefined)).toBe(false);
    });
  });

  describe('readActiveSession (FlowEngine runtime bridge)', () => {
    beforeEach(() => vi.resetAllMocks());

    it('returns empty arrays when runtime throws', () => {
      mockedGetRuntime.mockImplementation(() => {
        throw new Error('no runtime');
      });
      const result = readActiveSession('s1');
      expect(result.messages).toEqual([]);
      expect(result.attachments).toEqual([]);
    });

    it('returns messages and attachments from getSessionState', () => {
      mockedGetRuntime.mockReturnValue({
        chatMessageModel: {
          getSessionState: (sid?: string) => ({
            messages: sid === 's1' ? [{ key: 'm2' }] : [],
            attachments: sid === 's1' ? [{ filename: 'b.pdf' }] : [],
          }),
        },
        chatConversationModel: { currentConversation: 's1' },
      } as any);
      expect(readActiveSession('s1')).toEqual({
        messages: [{ key: 'm2' }],
        attachments: [{ filename: 'b.pdf' }],
      });
    });

    it('falls back to empty arrays when session fields are not arrays', () => {
      mockedGetRuntime.mockReturnValue({
        chatMessageModel: { getSessionState: () => ({ messages: null, attachments: 'bad' }) },
        chatConversationModel: { currentConversation: undefined },
      } as any);
      const result = readActiveSession();
      expect(result.messages).toEqual([]);
      expect(result.attachments).toEqual([]);
    });
  });

  describe('skillhub manifest', () => {
    const manifestUrl = '/api/skillHub:download?execId=42&f=cmVwb3J0LmRvY3g';
    const manifestComment = `<!--skillhub:files ${JSON.stringify([
      { name: 'report.docx', downloadUrl: manifestUrl, mimetype: null, size: 123, execId: '42' },
    ])}-->`;

    it('parses manifest embedded in a tool_calls content', () => {
      const messages = [
        {
          content: {
            content: 'Here is your file.',
            tool_calls: [{ id: 't1', name: 'gen', content: `done\n${manifestComment}` }],
          },
        },
      ];
      const map = buildSkillHubManifestMap(messages);
      expect(map.get('report.docx')?.downloadUrl).toBe(manifestUrl);
    });

    it('parses manifest embedded in plain string content', () => {
      const messages = [{ content: `text ${manifestComment}` }];
      const map = buildSkillHubManifestMap(messages);
      expect(map.size).toBe(1);
    });

    it('resolves an entry by display name with noise', () => {
      const map = buildSkillHubManifestMap([{ content: manifestComment }]);
      expect(findManifestEntryForName('"report.docx"', map)?.downloadUrl).toBe(manifestUrl);
    });

    it('returns null when no manifest matches', () => {
      const map = buildSkillHubManifestMap([{ content: 'no manifest here' }]);
      expect(map.size).toBe(0);
      expect(findManifestEntryForName('report.docx', map)).toBeNull();
    });

    it('prefers the most recent manifest entry for the same filename', () => {
      const older = `<!--skillhub:files ${JSON.stringify([
        { name: 'report.docx', downloadUrl: '/api/skillHub:download?execId=1&f=x' },
      ])}-->`;
      const map = buildSkillHubManifestMap([{ content: older }, { content: manifestComment }]);
      expect(map.get('report.docx')?.downloadUrl).toBe(manifestUrl);
    });
  });
});
