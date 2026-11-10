/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { RobotOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Form, Input, Typography } from 'antd';
import { Instruction, WorkflowTypedVariableInput } from '@nocobase/plugin-workflow/client-v2';
import { tExpr, useT } from './locale';

function ContextFields() {
  const t = useT();
  return <Typography.Text>{t('The request and pinned Git context are supplied by Git Manager.')}</Typography.Text>;
}

function ReviewLLMFallback() {
  const t = useT();
  return <Typography.Text>{t('The AI plugin is required to edit LLM settings.')}</Typography.Text>;
}

export class ReviewLLMInstruction extends Instruction {
  type = 'git-review-llm';
  title = tExpr('Git review LLM');
  description = tExpr('Run a structured review with the configured AI service.');
  group = 'git-review';
  async = true;
  icon = (<RobotOutlined />);
  FieldsetLoader: Instruction['FieldsetLoader'] = async () => ({ default: ReviewLLMFallback });
  useVariables({ key, title }: { key: string; title: string }) {
    return {
      value: key,
      label: title,
      children: [
        { value: 'content', label: tExpr('Content') },
        { value: 'structuredContent', label: tExpr('Structured content') },
        { value: 'additionalKwargs', label: tExpr('Additional Kwargs') },
      ],
    };
  }
}

function ManualFields() {
  const t = useT();
  return (
    <Typography.Text>
      {t('Edit manual nodes in the legacy canvas. Configure Git review approvers in Git Review Workflows settings.')}
    </Typography.Text>
  );
}

export class NativeManualInstruction extends Instruction {
  type = 'manual';
  title = tExpr('Manual approval');
  description = tExpr('Wait for a review decision from an assigned user.');
  group = 'manual';
  icon = (<SafetyCertificateOutlined />);
  FieldsetLoader = async () => ({ default: ManualFields });
  isAvailable() {
    return false;
  }
  useVariables({ key, title }: { key: string; title: string }) {
    return { value: key, label: title };
  }
}

function ResultFields() {
  const t = useT();
  return (
    <Form.Item name={['config', 'value']} label={t('Structured review')} rules={[{ required: true }]}>
      <WorkflowTypedVariableInput />
    </Form.Item>
  );
}

function PublishFields() {
  const t = useT();
  return (
    <>
      <Form.Item name={['config', 'result']} label={t('Validated result')} rules={[{ required: true }]}>
        <WorkflowTypedVariableInput />
      </Form.Item>
      <Form.Item name={['config', 'approvalNodeKey']} label={t('Human approval node key')}>
        <Input />
      </Form.Item>
    </>
  );
}

export class ContextInstruction extends Instruction {
  type = 'git-review-context';
  title = tExpr('Git review context');
  description = tExpr('Claim the request and load its pinned Git context.');
  group = 'git-review';
  icon = (<SafetyCertificateOutlined />);
  FieldsetLoader = async () => ({ default: ContextFields });
  useVariables({ key, title }: { key: string; title: string }) {
    return { value: key, label: title };
  }
}

export class ResultInstruction extends Instruction {
  type = 'git-review-result';
  title = tExpr('Validate Git review');
  description = tExpr('Validate structured findings and save the exact review.');
  group = 'git-review';
  icon = (<SafetyCertificateOutlined />);
  FieldsetLoader = async () => ({ default: ResultFields });
  useVariables({ key, title }: { key: string; title: string }) {
    return { value: key, label: title };
  }
}

export class PublishInstruction extends Instruction {
  type = 'git-review-publish';
  title = tExpr('Publish Git review');
  description = tExpr('Publish the saved result after any required human approval.');
  group = 'git-review';
  icon = (<SafetyCertificateOutlined />);
  FieldsetLoader = async () => ({ default: PublishFields });
  useVariables({ key, title }: { key: string; title: string }) {
    return { value: key, label: title };
  }
}

export type ReviewWorkflowClient = {
  registerInstructionGroup(key: string, group: { key: string; label: string }): void;
  registerInstruction(type: string, instruction: Instruction | { new (): Instruction }): void;
  instructions?: { get(type: string): Instruction | undefined };
};

export function registerInstructions(workflow: ReviewWorkflowClient) {
  workflow.registerInstructionGroup('git-review', { key: 'git-review', label: tExpr('Git review') });
  const llm = new ReviewLLMInstruction();
  const nativeLLM = workflow.instructions?.get('llm');
  if (nativeLLM?.FieldsetLoader) llm.FieldsetLoader = nativeLLM.FieldsetLoader;
  workflow.registerInstruction('git-review-llm', llm);
  workflow.registerInstruction('git-review-context', ContextInstruction);
  workflow.registerInstruction('git-review-result', ResultInstruction);
  workflow.registerInstruction('git-review-publish', PublishInstruction);
}
