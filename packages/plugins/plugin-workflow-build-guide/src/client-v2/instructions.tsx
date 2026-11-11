/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { FileTextOutlined, RobotOutlined, UploadOutlined } from '@ant-design/icons';
import { Form, Select, Typography } from 'antd';
import { Instruction } from '@nocobase/plugin-workflow/client-v2';
import { tExpr, useT } from './locale';

function PrepareFields() {
  const t = useT();
  return (
    <Typography.Paragraph>
      {t('This managed step claims the build run and prepares its pinned source documents.')}
    </Typography.Paragraph>
  );
}

function LLMFields() {
  const t = useT();
  return (
    <>
      <Form.Item name={['config', 'mode']} label={t('Step mode')}>
        <Select
          disabled
          options={[
            { value: 'plan', label: t('Plan outline') },
            { value: 'chapter', label: t('Write chapter') },
          ]}
        />
      </Form.Item>
      <Typography.Paragraph type="secondary">
        {t('The AI provider, model, and prompts are managed in the Build Guide space settings.')}
      </Typography.Paragraph>
    </>
  );
}

function PublishFields() {
  const t = useT();
  return (
    <Typography.Paragraph>
      {t('This managed step validates and publishes the complete guide for its current run.')}
    </Typography.Paragraph>
  );
}

export class GuideBuildPrepareInstruction extends Instruction {
  type = 'guide-build-prepare';
  title = tExpr('Prepare guide build');
  description = tExpr('Claim the run and load its pinned source documents.');
  group = 'workflow-build-guide';
  icon = (<FileTextOutlined />);
  FieldsetLoader = async () => ({ default: PrepareFields });

  isAvailable() {
    return false;
  }

  useVariables({ key, title }: { key: string; title: string }) {
    return { value: key, label: title };
  }
}

export class GuideBuildLLMInstruction extends Instruction {
  type = 'guide-build-llm';
  title = tExpr('Build Guide AI step');
  description = tExpr('Plan chapters or write one chapter using the configured Build Guide space.');
  group = 'workflow-build-guide';
  async = true;
  icon = (<RobotOutlined />);
  FieldsetLoader = async () => ({ default: LLMFields });

  createDefaultConfig() {
    return { mode: 'plan' as const };
  }

  isAvailable() {
    return false;
  }

  useVariables({ key, title }: { key: string; title: string }) {
    return {
      value: key,
      label: title,
      children: [{ value: 'chapterKeys', label: tExpr('Chapter keys') }],
    };
  }
}

export class GuideBuildPublishInstruction extends Instruction {
  type = 'guide-build-publish';
  title = tExpr('Publish guide');
  description = tExpr('Validate and publish the complete guide.');
  group = 'workflow-build-guide';
  icon = (<UploadOutlined />);
  FieldsetLoader = async () => ({ default: PublishFields });

  isAvailable() {
    return false;
  }

  useVariables({ key, title }: { key: string; title: string }) {
    return { value: key, label: title };
  }
}

export type GuideBuildWorkflowClient = {
  registerInstructionGroup(key: string, group: { key: string; label: string }): void;
  registerInstruction(type: string, instruction: Instruction | { new (): Instruction }): void;
};

export function registerInstructions(workflow: GuideBuildWorkflowClient) {
  workflow.registerInstructionGroup('workflow-build-guide', {
    key: 'workflow-build-guide',
    label: tExpr('Build Guide'),
  });
  workflow.registerInstruction('guide-build-prepare', GuideBuildPrepareInstruction);
  workflow.registerInstruction('guide-build-llm', GuideBuildLLMInstruction);
  workflow.registerInstruction('guide-build-publish', GuideBuildPublishInstruction);
}
