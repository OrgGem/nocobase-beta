// SPDX-License-Identifier: Apache-2.0

import type { ConfigDiffResult, DiffLine } from './types';

const MAX_EXACT_LCS_LINES = 2000;
const MAX_RETURNED_DIFF_LINES = 6000;
const GREEDY_LOOKAHEAD = 32;

export function normalizeConfigLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') {
    return [];
  }
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function diffMiddleExactLcs(
  left: readonly string[],
  right: readonly string[],
  leftOffset: number,
  rightOffset: number,
): DiffLine[] {
  const n = left.length;
  const m = right.length;
  const cols = m + 1;
  const dp = new Uint32Array((n + 1) * cols);

  for (let i = n - 1; i >= 0; i--) {
    const rowBase = i * cols;
    const nextRowBase = (i + 1) * cols;
    const leftLine = left[i];
    for (let j = m - 1; j >= 0; j--) {
      if (leftLine === right[j]) {
        dp[rowBase + j] = dp[nextRowBase + j + 1] + 1;
      } else {
        const down = dp[nextRowBase + j];
        const across = dp[rowBase + j + 1];
        dp[rowBase + j] = down >= across ? down : across;
      }
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      out.push({
        type: 'context',
        oldLineNumber: leftOffset + i + 1,
        newLineNumber: rightOffset + j + 1,
        content: left[i],
      });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      out.push({
        type: 'del',
        oldLineNumber: leftOffset + i + 1,
        newLineNumber: null,
        content: left[i],
      });
      i += 1;
    } else {
      out.push({
        type: 'add',
        oldLineNumber: null,
        newLineNumber: rightOffset + j + 1,
        content: right[j],
      });
      j += 1;
    }
  }

  while (i < n) {
    out.push({
      type: 'del',
      oldLineNumber: leftOffset + i + 1,
      newLineNumber: null,
      content: left[i],
    });
    i += 1;
  }
  while (j < m) {
    out.push({
      type: 'add',
      oldLineNumber: null,
      newLineNumber: rightOffset + j + 1,
      content: right[j],
    });
    j += 1;
  }
  return out;
}

// shortcut: uses bounded lookahead when changed middle exceeds 2000 lines per side, upgrade to Myers O(ND) if >5k-line middle diffs need minimal edit scripts
function diffMiddleGreedy(
  left: readonly string[],
  right: readonly string[],
  leftOffset: number,
  rightOffset: number,
): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({
        type: 'context',
        oldLineNumber: leftOffset + i + 1,
        newLineNumber: rightOffset + j + 1,
        content: left[i],
      });
      i += 1;
      j += 1;
      continue;
    }

    let syncRight = -1;
    for (let k = 1; k <= GREEDY_LOOKAHEAD && j + k < right.length; k++) {
      if (left[i] === right[j + k]) {
        syncRight = k;
        break;
      }
    }
    let syncLeft = -1;
    for (let k = 1; k <= GREEDY_LOOKAHEAD && i + k < left.length; k++) {
      if (left[i + k] === right[j]) {
        syncLeft = k;
        break;
      }
    }

    if (syncRight !== -1 && (syncLeft === -1 || syncRight <= syncLeft)) {
      for (let step = 0; step < syncRight; step++) {
        out.push({
          type: 'add',
          oldLineNumber: null,
          newLineNumber: rightOffset + j + 1,
          content: right[j],
        });
        j += 1;
      }
    } else if (syncLeft !== -1) {
      for (let step = 0; step < syncLeft; step++) {
        out.push({
          type: 'del',
          oldLineNumber: leftOffset + i + 1,
          newLineNumber: null,
          content: left[i],
        });
        i += 1;
      }
    } else {
      out.push({
        type: 'del',
        oldLineNumber: leftOffset + i + 1,
        newLineNumber: null,
        content: left[i],
      });
      out.push({
        type: 'add',
        oldLineNumber: null,
        newLineNumber: rightOffset + j + 1,
        content: right[j],
      });
      i += 1;
      j += 1;
    }
  }

  while (i < left.length) {
    out.push({
      type: 'del',
      oldLineNumber: leftOffset + i + 1,
      newLineNumber: null,
      content: left[i],
    });
    i += 1;
  }
  while (j < right.length) {
    out.push({
      type: 'add',
      oldLineNumber: null,
      newLineNumber: rightOffset + j + 1,
      content: right[j],
    });
    j += 1;
  }
  return out;
}

export function computeConfigDiff(
  leftText: string,
  rightText: string,
  leftLabel = 'Base',
  rightLabel = 'Target',
): ConfigDiffResult {
  const leftLines = normalizeConfigLines(leftText);
  const rightLines = normalizeConfigLines(rightText);

  let prefixLen = 0;
  const minLen = Math.min(leftLines.length, rightLines.length);
  while (prefixLen < minLen && leftLines[prefixLen] === rightLines[prefixLen]) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < leftLines.length - prefixLen &&
    suffixLen < rightLines.length - prefixLen &&
    leftLines[leftLines.length - 1 - suffixLen] === rightLines[rightLines.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  const leftMiddle = leftLines.slice(prefixLen, leftLines.length - suffixLen);
  const rightMiddle = rightLines.slice(prefixLen, rightLines.length - suffixLen);

  const lines: DiffLine[] = [];
  for (let idx = 0; idx < prefixLen; idx++) {
    lines.push({
      type: 'context',
      oldLineNumber: idx + 1,
      newLineNumber: idx + 1,
      content: leftLines[idx],
    });
  }

  if (leftMiddle.length > 0 || rightMiddle.length > 0) {
    const useExact = leftMiddle.length <= MAX_EXACT_LCS_LINES && rightMiddle.length <= MAX_EXACT_LCS_LINES;
    const middleDiff = useExact
      ? diffMiddleExactLcs(leftMiddle, rightMiddle, prefixLen, prefixLen)
      : diffMiddleGreedy(leftMiddle, rightMiddle, prefixLen, prefixLen);
    lines.push(...middleDiff);
  }

  const leftSuffixStart = leftLines.length - suffixLen;
  const rightSuffixStart = rightLines.length - suffixLen;
  for (let idx = 0; idx < suffixLen; idx++) {
    lines.push({
      type: 'context',
      oldLineNumber: leftSuffixStart + idx + 1,
      newLineNumber: rightSuffixStart + idx + 1,
      content: leftLines[leftSuffixStart + idx],
    });
  }

  let addedCount = 0;
  let deletedCount = 0;
  let unchangedCount = 0;
  for (const l of lines) {
    if (l.type === 'add') addedCount += 1;
    else if (l.type === 'del') deletedCount += 1;
    else unchangedCount += 1;
  }

  const truncated = lines.length > MAX_RETURNED_DIFF_LINES;
  return {
    leftLabel,
    rightLabel,
    identical: addedCount === 0 && deletedCount === 0,
    addedCount,
    deletedCount,
    unchangedCount,
    truncated,
    lines: truncated ? lines.slice(0, MAX_RETURNED_DIFF_LINES) : lines,
  };
}
