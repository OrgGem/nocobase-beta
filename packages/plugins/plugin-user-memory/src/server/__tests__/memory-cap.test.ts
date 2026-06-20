import { describe, it, expect } from 'vitest';
import { truncateToMaxChars } from '../services/memory-synthesizer';
import { mergeRelatedSessions, MAX_RELATED_SESSIONS } from '../services/memory-profile.service';
import { appendUserNote } from '../tools/remember-tool';
import type { RelatedSession } from '../services/conversation-extractor';

describe('truncateToMaxChars', () => {
  it('returns content unchanged when within the cap', () => {
    const content = 'short profile';
    expect(truncateToMaxChars(content, 2000)).toBe(content);
  });

  it('never exceeds the cap when cutting at a section boundary', () => {
    const content =
      '## A\n' + 'a'.repeat(1200) + '\n## B\n' + 'b'.repeat(1200) + '\n## C\n' + 'c'.repeat(1200);
    const out = truncateToMaxChars(content, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
  });

  it('never exceeds the cap when falling back to a word boundary (no headings)', () => {
    const content = ('word '.repeat(1000)).trim();
    const out = truncateToMaxChars(content, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});

describe('mergeRelatedSessions', () => {
  const mk = (id: string, daysAgo: number): RelatedSession => ({
    sessionId: id,
    title: `Session ${id}`,
    updatedAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  });

  it('dedupes by sessionId, keeping the incoming (newer) entry', () => {
    const existing = [mk('s1', 5)];
    const incoming = [{ ...mk('s1', 1), title: 'Updated' }];
    const merged = mergeRelatedSessions(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Updated');
  });

  it('sorts by updatedAt desc and caps at MAX_RELATED_SESSIONS', () => {
    const existing = Array.from({ length: 8 }, (_, i) => mk(`old-${i}`, 20 + i));
    const incoming = Array.from({ length: 8 }, (_, i) => mk(`new-${i}`, i));
    const merged = mergeRelatedSessions(existing, incoming);
    expect(merged.length).toBe(MAX_RELATED_SESSIONS);
    // Newest first
    expect(merged[0].sessionId).toBe('new-0');
  });

  it('ignores entries without a sessionId', () => {
    const merged = mergeRelatedSessions([], [{ sessionId: '', title: 'x', updatedAt: '' } as RelatedSession]);
    expect(merged).toHaveLength(0);
  });
});

describe('appendUserNote', () => {
  it('creates a User Notes section when none exists', () => {
    const out = appendUserNote('', 'Prefers Vietnamese');
    expect(out).toContain('## User Notes');
    expect(out).toContain('- Prefers Vietnamese');
  });

  it('appends into an existing User Notes section', () => {
    const existing = '## User Notes\n- First note';
    const out = appendUserNote(existing, 'Second note');
    expect(out).toContain('- First note');
    expect(out).toContain('- Second note');
  });

  it('does not duplicate an identical note', () => {
    const existing = '## User Notes\n- Prefers Vietnamese';
    const out = appendUserNote(existing, 'Prefers Vietnamese');
    const occurrences = out.split('- Prefers Vietnamese').length - 1;
    expect(occurrences).toBe(1);
  });

  it('inserts notes before a following section, not at the very end', () => {
    const existing = '## User Notes\n- First\n\n## Technical Preferences\n- React';
    const out = appendUserNote(existing, 'Second');
    const notesIdx = out.indexOf('- Second');
    const techIdx = out.indexOf('## Technical Preferences');
    expect(notesIdx).toBeLessThan(techIdx);
  });

  it('preserves existing profile content when appending a new section', () => {
    const existing = '## Personality\n- Friendly';
    const out = appendUserNote(existing, 'Likes dark mode');
    expect(out).toContain('## Personality');
    expect(out).toContain('- Friendly');
    expect(out).toContain('## User Notes');
  });
});
