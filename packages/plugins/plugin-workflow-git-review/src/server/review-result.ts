/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { isRecord } from './contracts';

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'coverage'],
  properties: {
    verdict: { type: 'string', enum: ['findings', 'no_findings'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'file', 'line', 'description', 'recommendation'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          description: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'limitations'],
      properties: { summary: { type: 'string' }, limitations: { type: 'array', items: { type: 'string' } } },
    },
  },
};

type Finding = {
  title: string;
  severity: string;
  file: string;
  line: number;
  description: string;
  recommendation: string;
};
export type StructuredReview = {
  verdict: 'findings' | 'no_findings';
  findings: Finding[];
  coverage: { summary: string; limitations: string[] };
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseReview(value: unknown): StructuredReview {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['verdict', 'findings', 'coverage']) ||
    !Array.isArray(value.findings) ||
    !isRecord(value.coverage) ||
    !onlyKeys(value.coverage, ['summary', 'limitations'])
  ) {
    throw new Error('Review output must be structured and include findings and coverage');
  }
  const { verdict, findings, coverage } = value;
  if (verdict !== 'findings' && verdict !== 'no_findings') {
    throw new Error('Review verdict is missing or invalid');
  }
  if ((verdict === 'no_findings') !== (findings.length === 0)) {
    throw new Error('Review verdict does not match its findings');
  }
  if (!nonempty(coverage.summary) || !Array.isArray(coverage.limitations) || !coverage.limitations.every(nonempty)) {
    throw new Error('Review coverage and limitations are required');
  }
  for (const finding of findings) {
    if (
      !isRecord(finding) ||
      !onlyKeys(finding, ['title', 'severity', 'file', 'line', 'description', 'recommendation']) ||
      !nonempty(finding.title) ||
      !nonempty(finding.file) ||
      !nonempty(finding.description) ||
      !nonempty(finding.recommendation) ||
      typeof finding.line !== 'number' ||
      !Number.isSafeInteger(finding.line) ||
      finding.line < 1 ||
      !['critical', 'high', 'medium', 'low', 'info'].includes(String(finding.severity))
    ) {
      throw new Error('Each finding requires severity, file, line, description, and recommendation');
    }
  }
  return value as StructuredReview;
}

export function validateFindingLocations(review: StructuredReview, diff: string): void {
  const locations = new Map<string, Set<number>>();
  let file = '';
  let line = 0;
  let inHunk = false;
  for (const row of diff.split(/\r?\n/)) {
    if (row.startsWith('+++ ')) {
      const path = row.slice(4).split('\t')[0];
      file = path.startsWith('b/') ? path.slice(2) : path;
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file || file === '/dev/null') continue;
    if (row.startsWith(' ') || row.startsWith('+')) {
      if (!locations.has(file)) locations.set(file, new Set());
      locations.get(file)?.add(line);
      line += 1;
    } else if (!row.startsWith('-') && !row.startsWith('\\')) {
      inHunk = false;
    }
  }
  for (const finding of review.findings) {
    const path = finding.file.replace(/^b\//, '');
    if (!locations.get(path)?.has(finding.line)) {
      throw new Error(`Finding location is not present in the reviewed diff: ${finding.file}:${finding.line}`);
    }
  }
}

export function renderReview(review: StructuredReview, headSha: string): string {
  const lines = [`# Code review`, ``, `Reviewed commit: \`${headSha}\``, ``, `## Findings`];
  if (!review.findings.length) lines.push('', 'No findings reported.');
  for (const finding of review.findings) {
    lines.push(
      '',
      `### ${finding.severity.toUpperCase()}: ${finding.title}`,
      '',
      `Location: \`${finding.file}:${finding.line}\``,
      '',
      finding.description,
      '',
      `Recommendation: ${finding.recommendation}`,
    );
  }
  lines.push('', '## Coverage', '', review.coverage.summary, '', '### Limitations');
  lines.push(
    ...(review.coverage.limitations.length
      ? review.coverage.limitations.map((item) => `- ${item}`)
      : ['- None reported.']),
  );
  return lines.join('\n');
}
