import {
  stripFilenameNoise,
  extractFilenameFromText,
  getDisplayNameCandidates,
  isKnownFileUrl,
  selectChatAttachments,
  selectChatMessages,
  buildSkillHubManifestMap,
  findManifestEntryForName,
} from '../ChatFilePreviewProvider';

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

  describe('chat store selectors', () => {
    it('should read legacy flat chat message state', () => {
      expect(selectChatMessages({ messages: [{ key: 'm1' }], attachments: [] })).toEqual([{ key: 'm1' }]);
      expect(selectChatAttachments({ messages: [], attachments: [{ filename: 'a.pdf' }] })).toEqual([
        { filename: 'a.pdf' },
      ]);
    });

    it('should read NocoBase 2.1 session chat message state', () => {
      const state = {
        sessions: {
          s1: {
            messages: [{ key: 'm2' }],
            attachments: [{ filename: 'b.pdf' }],
          },
        },
      };

      expect(selectChatMessages(state, 's1')).toEqual([{ key: 'm2' }]);
      expect(selectChatAttachments(state, 's1')).toEqual([{ filename: 'b.pdf' }]);
    });

    it('should read session arrays directly when getSessionState is also available', () => {
      const state = {
        sessions: {
          s2: {
            messages: [{ key: 'm4' }],
            attachments: [{ filename: 'd.pdf' }],
          },
        },
        getSessionState: () => ({
          messages: [{ key: 'm3' }],
          attachments: [{ filename: 'c.pdf' }],
        }),
      };

      expect(selectChatMessages(state, 's2')).toBe(state.sessions.s2.messages);
      expect(selectChatAttachments(state, 's2')).toBe(state.sessions.s2.attachments);
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
