/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Lightweight script/range-based language detection for text splitting and
 * embedding optimization. This is intentionally heuristic (no ML model) — it
 * detects the dominant Unicode script of a sample, which covers the most
 * common multi-language KB scenarios:
 *
 * - Vietnamese: heavy use of Latin Extended Additional (ư, ơ, ạ, ế …)
 * - CJK: Chinese/Japanese/Korean ideographs and kana
 * - Cyrillic / Arabic / Greek / Hebrew / Thai
 * - Default fallback: Latin (English/European)
 */

export type DetectedLanguage = 'vi' | 'zh' | 'ja' | 'ko' | 'ru' | 'ar' | 'el' | 'he' | 'th' | 'en';

const SCRIPT_RANGES: Array<{ lang: DetectedLanguage; regex: RegExp }> = [
  { lang: 'zh', regex: /[\u4e00-\u9fff]/g },
  { lang: 'ja', regex: /[\u3040-\u30ff]/g },
  { lang: 'ko', regex: /[\uac00-\ud7af\u1100-\u11ff]/g },
  { lang: 'vi', regex: /[\u0102\u0103\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]/g },
  { lang: 'ru', regex: /[\u0400-\u04ff]/g },
  { lang: 'ar', regex: /[\u0600-\u06ff]/g },
  { lang: 'el', regex: /[\u0370-\u03ff]/g },
  { lang: 'he', regex: /[\u0590-\u05ff]/g },
  { lang: 'th', regex: /[\u0e00-\u0e7f]/g },
];

/** Characters sampled from the text for detection (performance cap). */
const SAMPLE_LENGTH = 4000;

export function detectLanguage(text: string): DetectedLanguage {
  if (!text) return 'en';
  const sample = text.slice(0, SAMPLE_LENGTH);

  // Count matches per script
  let bestLang: DetectedLanguage = 'en';
  let bestCount = 0;
  for (const { lang, regex } of SCRIPT_RANGES) {
    const matches = sample.match(regex);
    if (!matches) continue;
    if (lang === 'vi') {
      // Vietnamese uses many diacritics but still mostly basic Latin; weight to win ties with en
      if (matches.length > bestCount) {
        bestCount = matches.length;
        bestLang = 'vi';
      }
      continue;
    }
    if (matches.length > bestCount) {
      bestCount = matches.length;
      bestLang = lang;
    }
  }

  if (bestLang !== 'en') return bestLang;

  // No strong non-Latin signal → decide between Vietnamese-heavy and generic Latin
  const viMatches = sample.match(/[\u0102\u0103\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]/g);
  if (viMatches && viMatches.length > sample.length * 0.05) {
    return 'vi';
  }
  return 'en';
}

/**
 * Language-aware separator sets for RecursiveCharacterTextSplitter.
 * CJK has no spaces between words; sentence-ending punctuation is the main boundary.
 */
export function getSeparatorsForLanguage(lang: DetectedLanguage): string[] | undefined {
  switch (lang) {
    case 'zh':
    case 'ja':
      return ['\n\n', '\n', '。', '！', '？', '；', '、', ' ', ''];
    case 'ko':
      return ['\n\n', '\n', '. ', '! ', '? ', ' ', ''];
    case 'th':
      return ['\n\n', '\n', ' ', '', ''];
    default:
      // Latin/Cyrillic/Arabic/etc. — library defaults are fine
      return undefined;
  }
}

/**
 * Suggested chunk-size multiplier. Some languages (CJK, Thai) carry more
 * information per character than spaced languages; slightly smaller chunks
 * keep embeddings focused.
 */
export function getChunkSizeMultiplier(lang: DetectedLanguage): number {
  switch (lang) {
    case 'zh':
    case 'ja':
    case 'ko':
    case 'th':
      return 0.6;
    default:
      return 1;
  }
}
