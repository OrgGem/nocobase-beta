import { FilePdfOutlined } from '@ant-design/icons';
import { tExpr } from '@nocobase/flow-engine';
import { Instruction } from '@nocobase/plugin-workflow/client-v2';
import React from 'react';
import { NAMESPACE } from '../../shared/constants';

export default class CarboneRenderInstruction extends Instruction {
  title = tExpr('Render Carbone document', { ns: NAMESPACE });
  type = 'carbone-render';
  group = 'extended';
  description = tExpr(
    'Render a managed Carbone template with data from upstream nodes. Returns the attachment id and URL.',
    { ns: NAMESPACE },
  );
  icon = (<FilePdfOutlined />);
  FieldsetLoader = () => import('./CarboneRenderFieldset');

  useVariables({ key, title }: { key: string; title: string }) {
    const labels = {
      attachmentId: 'Attachment id',
      url: 'Attachment URL',
      format: 'Output format',
      size: 'Size',
      cacheHit: 'Cache hit',
      durationMs: 'Render duration (ms)',
      carboneTemplateId: 'Carbone ID',
    };
    return {
      value: key,
      label: title,
      children: Object.entries(labels).map(([value, label]) => ({
        isLeaf: true,
        value,
        key: value,
        label: tExpr(label, { ns: NAMESPACE }),
      })),
    };
  }
}
