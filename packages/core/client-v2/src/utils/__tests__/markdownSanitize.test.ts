/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, it, expect } from 'vitest';
import { stripMarkdownIframeTags, stripMarkdownIframes, removeMarkdownIframes } from '../markdownSanitize';

describe('markdownSanitize', () => {
  describe('stripMarkdownIframeTags', () => {
    it('returns input unchanged when falsy', () => {
      expect(stripMarkdownIframeTags('')).toBe('');
      expect(stripMarkdownIframeTags(null as any)).toBeNull();
      expect(stripMarkdownIframeTags(undefined as any)).toBeUndefined();
    });

    it('keeps plain markdown unchanged', () => {
      const md = '# Title\n\nSome **bold** text.';
      expect(stripMarkdownIframeTags(md)).toBe(md);
    });

    it('removes a full iframe block', () => {
      const md = 'hello\n\n<iframe src="https://example.com"></iframe>\n\nworld';
      expect(stripMarkdownIframeTags(md)).toBe('hello\n\n\n\nworld');
    });

    it('removes self-closing iframe', () => {
      const md = 'a <iframe src="x" /> b';
      expect(stripMarkdownIframeTags(md)).toBe('a  b');
    });

    it('removes iframe with attributes containing > inside quotes', () => {
      const md = '<iframe data-x="a > b" src="https://e.com"></iframe>';
      expect(stripMarkdownIframeTags(md)).toBe('');
    });
  });

  describe('stripMarkdownIframes', () => {
    it('uses DOMParser when available to strip iframes', () => {
      // jsdom provides DOMParser: iframes get removed, text content stays.
      const out = stripMarkdownIframes('<p>hello</p><iframe src="x"></iframe>');
      expect(out).toContain('hello');
      expect(out).not.toContain('iframe');
    });

    it('returns empty for empty input', () => {
      expect(stripMarkdownIframes('')).toBe('');
    });
  });

  describe('removeMarkdownIframes', () => {
    it('handles null container', () => {
      expect(() => removeMarkdownIframes(null)).not.toThrow();
    });
  });
});