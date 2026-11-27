// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { FileSearchOutlined } from '@ant-design/icons';
import { Instruction } from '@nocobase/plugin-workflow/client-v2';
import { tExpr } from '../locale';

export default class DocumentUnderstandingInstruction extends Instruction {
  type = 'document-understanding';
  title = tExpr('Document Understanding');
  group = 'extended';
  description = tExpr(
    'Parse, OCR, extract, analyze, transform, compare, or audit L/C & disbursement documents via Document Understanding.',
  );
  icon = (<FileSearchOutlined />);

  FieldsetLoader = () =>
    import('./DocumentUnderstandingFieldset').then((module) => ({
      default: module.DocumentUnderstandingFieldset,
    }));

  createDefaultConfig() {
    return {
      mode: 'business_action',
      businessId: 'document-core',
      action: 'extract',
      variant: 'invoice',
      ignoreFail: false,
    };
  }

  useVariables({ key, title }: { key: string; title: string }) {
    return {
      value: key,
      label: title,
      children: [
        { value: 'operationId', label: tExpr('Operation ID') },
        { value: 'state', label: tExpr('State') },
        { value: 'data', label: tExpr('Structured Data') },
        { value: 'markdown', label: tExpr('Markdown Content') },
        { value: 'text', label: tExpr('Plain Text') },
        { value: 'report', label: tExpr('Report') },
        { value: 'verdict', label: tExpr('Verdict') },
        { value: 'discrepancies', label: tExpr('Discrepancies') },
        { value: 'usage', label: tExpr('Token & Cost Usage') },
      ],
    };
  }
}
