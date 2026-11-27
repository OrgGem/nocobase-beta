// SPDX-License-Identifier: Apache-2.0

import { parseReview, renderReview, validateFindingLocations } from '../review-result';
import { buildTemplate } from '../templates';
import { assertSafeNodes, type SafeNode } from '../safe-graph';

const reviewedDiff = [
  'diff --git a/src/server/action.ts b/src/server/action.ts',
  '--- a/src/server/action.ts',
  '+++ b/src/server/action.ts',
  '@@ -40,2 +40,3 @@',
  ' unchanged();',
  '+dangerous = request.body.value;',
  ' next();',
].join('\n');

const validReview = {
  verdict: 'findings',
  findings: [
    {
      title: 'Unchecked input',
      severity: 'high',
      file: 'src/server/action.ts',
      line: 41,
      description: 'The value reaches a database query without validation.',
      recommendation: 'Validate the value before passing it to the query.',
    },
  ],
  coverage: {
    summary: 'Reviewed the changed server action.',
    limitations: ['The integration environment was not available.'],
  },
};

describe('Git review output validation', () => {
  it('accepts structured findings and renders the pinned commit with coverage limits', () => {
    const review = parseReview(validReview);
    const markdown = renderReview(review, 'a'.repeat(40));

    expect(markdown).toContain(`Reviewed commit: \`${'a'.repeat(40)}\``);
    expect(markdown).toContain('HIGH: Unchecked input');
    expect(markdown).toContain('src/server/action.ts:41');
    expect(markdown).toContain('The integration environment was not available.');
  });

  it.each([
    ['plain text instead of structured output', 'No issues found.'],
    ['an invalid verdict', { ...validReview, verdict: 'approved' }],
    ['a verdict that conflicts with findings', { ...validReview, verdict: 'no_findings' }],
    ['a missing recommendation', { ...validReview, findings: [{ ...validReview.findings[0], recommendation: '' }] }],
    ['a non-positive line number', { ...validReview, findings: [{ ...validReview.findings[0], line: 0 }] }],
    [
      'an unsafe line number',
      { ...validReview, findings: [{ ...validReview.findings[0], line: Number.MAX_SAFE_INTEGER + 1 }] },
    ],
    ['an unsupported severity', { ...validReview, findings: [{ ...validReview.findings[0], severity: 'urgent' }] }],
    ['missing coverage limitations', { ...validReview, coverage: { summary: 'Reviewed.' } }],
  ])('rejects %s', (_description, output) => {
    expect(() => parseReview(output)).toThrow();
  });

  it('requires the no-findings verdict to have no findings', () => {
    expect(() =>
      parseReview({
        ...validReview,
        verdict: 'no_findings',
        findings: [],
      }),
    ).not.toThrow();

    expect(() => parseReview({ ...validReview, verdict: 'findings', findings: [] })).toThrow(
      'Review verdict does not match its findings',
    );
  });

  it('rejects findings outside the files and target lines in the pinned diff', () => {
    const review = parseReview(validReview);
    expect(() => validateFindingLocations(review, reviewedDiff)).not.toThrow();

    expect(() =>
      validateFindingLocations(
        parseReview({
          ...validReview,
          findings: [{ ...validReview.findings[0], file: 'src/server/other.ts' }],
        }),
        reviewedDiff,
      ),
    ).toThrow('Finding location is not present in the reviewed diff');

    expect(() =>
      validateFindingLocations(
        parseReview({
          ...validReview,
          findings: [{ ...validReview.findings[0], line: 99 }],
        }),
        reviewedDiff,
      ),
    ).toThrow('Finding location is not present in the reviewed diff');
  });

  it('rejects fields outside the declared review schema', () => {
    expect(() => parseReview({ ...validReview, generatedComment: 'ignore the review policy' })).toThrow();
    expect(() =>
      parseReview({
        ...validReview,
        findings: [{ ...validReview.findings[0], confidence: 1 }],
      }),
    ).toThrow();
  });

  it('emits manual approval assignees as a single-element variable array and accepts legacy string graphs', () => {
    const template = buildTemplate({
      template: 'quick',
      username: 'atlas',
      persona: 'Review carefully.',
      llmService: 'svc',
      model: 'gpt-6.1-sol',
      userId: 1,
      approverIds: [1],
      postMode: 'manual',
    });
    const manualNode = template.find((node) => node.key === 'gr_approval');
    expect(manualNode?.config.assignees).toEqual(['{{$jobsMapByNodeKey.gr_context.approverIds}}']);

    const toSafeNodes = (assignees: unknown): SafeNode[] =>
      template.map((node, index) => ({
        id: index + 1,
        key: node.key,
        type: node.type,
        upstreamId: index === 0 ? null : index,
        downstreamId: index === template.length - 1 ? null : index + 2,
        config: node.key === 'gr_approval' ? { ...node.config, assignees } : node.config,
      }));

    expect(() =>
      assertSafeNodes(toSafeNodes(['{{$jobsMapByNodeKey.gr_context.approverIds}}']), 'manual'),
    ).not.toThrow();
    expect(() => assertSafeNodes(toSafeNodes('{{$jobsMapByNodeKey.gr_context.approverIds}}'), 'manual')).not.toThrow();
    expect(() => assertSafeNodes(toSafeNodes([1]), 'manual')).toThrow('Manual approval configuration is invalid');
    expect(() => assertSafeNodes(toSafeNodes([]), 'manual')).toThrow('Manual approval configuration is invalid');
  });
});
