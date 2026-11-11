/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type TemplateNode = {
  key: string;
  title: string;
  type: string;
  config: Record<string, unknown>;
  branchIndex?: number | null;
};

const ref = (node: string, field: string) => `{{$jobsMapByNodeKey.${node}.${field}}}`;

export const WORKFLOW_KEY = 'workflow-build-guide-managed';
export const WORKFLOW_MARKER = 'workflowBuildGuide';

export function buildTemplate(): TemplateNode[] {
  return [
    { key: 'guide_prepare', title: 'Prepare guide source snapshot', type: 'guide-build-prepare', config: {} },
    { key: 'guide_plan', title: 'Plan guide chapters', type: 'guide-build-llm', config: { mode: 'plan' } },
    {
      key: 'guide_chapters',
      title: 'Write guide chapters',
      type: 'loop',
      config: { target: ref('guide_plan', 'chapterKeys') },
    },
    {
      key: 'guide_chapter',
      title: 'Write one chapter',
      type: 'guide-build-llm',
      branchIndex: 0,
      config: { mode: 'chapter', chapterKey: '{{$scopes.guide_chapters.item}}' },
    },
    { key: 'guide_publish', title: 'Publish completed guide', type: 'guide-build-publish', config: {} },
  ];
}
