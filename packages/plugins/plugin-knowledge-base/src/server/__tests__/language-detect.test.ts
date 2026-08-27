import { describe, expect, it } from 'vitest';
import { detectLanguage, getChunkSizeMultiplier, getSeparatorsForLanguage } from '../services/language-detect';

describe('detectLanguage', () => {
  it('detects Vietnamese by diacritic density', () => {
    const text =
      'Tri thức là tài sản quan trọng. Hệ thống quản lý cơ sở tri thức giúp người dùng tìm kiếm thông tin nhanh chóng và hiệu quả.';
    expect(detectLanguage(text)).toBe('vi');
  });

  it('detects Chinese', () => {
    expect(detectLanguage('知识库管理系统可以帮助用户快速检索信息。')).toBe('zh');
  });

  it('detects Japanese (kana)', () => {
    expect(detectLanguage('ナレッジベースの管理システムです。')).toBe('ja');
  });

  it('detects Korean', () => {
    expect(detectLanguage('지식 베이스 관리 시스템입니다.')).toBe('ko');
  });

  it('detects Russian (Cyrillic)', () => {
    expect(detectLanguage('База знаний помогает пользователям находить информацию.')).toBe('ru');
  });

  it('falls back to English for plain Latin text', () => {
    expect(detectLanguage('The knowledge base system helps users find information quickly and efficiently.')).toBe(
      'en',
    );
  });

  it('returns en for empty text', () => {
    expect(detectLanguage('')).toBe('en');
  });
});

describe('getSeparatorsForLanguage / getChunkSizeMultiplier', () => {
  it('returns CJK separators for zh/ja and undefined for Latin languages', () => {
    expect(getSeparatorsForLanguage('zh')).toContain('。');
    expect(getSeparatorsForLanguage('ja')).toContain('。');
    expect(getSeparatorsForLanguage('en')).toBeUndefined();
    expect(getSeparatorsForLanguage('vi')).toBeUndefined();
  });

  it('reduces chunk size for CJK/Thai languages', () => {
    expect(getChunkSizeMultiplier('zh')).toBeLessThan(1);
    expect(getChunkSizeMultiplier('th')).toBeLessThan(1);
    expect(getChunkSizeMultiplier('en')).toBe(1);
    expect(getChunkSizeMultiplier('vi')).toBe(1);
  });
});
