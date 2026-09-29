/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { Button, Modal } from 'antd';
import { FlowModel } from '../../../../models';
import { useFlowContext } from '../../../..';
import { FlowsSettings } from '../embedded/FlowsSettings';
import { observer } from '../../../../reactive';

export interface FlowsModalWrapperProps {
  model: FlowModel;
  children?: React.ReactNode;
  showDeleteButton?: boolean;
  title?: string;
  width?: number | string;
}

const hasNestedInteractiveElement = (target: EventTarget | null, boundary: HTMLElement): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const selectors =
    'button, a[href], input, textarea, select, [role="button"], [contenteditable="true"], [data-settings-trigger]';
  let el: HTMLElement | null = target;
  while (el && el !== boundary) {
    if (el.matches(selectors)) return true;
    el = el.parentElement;
  }
  return false;
};

const FlowsModalWrapperContent: React.FC<FlowsModalWrapperProps> = ({
  model,
  children,
  showDeleteButton,
  title,
  width = 600,
}) => {
  const [open, setOpen] = useState(false);

  const handleDelete = async () => {
    await model.destroy?.();
    setOpen(false);
  };

  return (
    <>
      <div
        data-settings-trigger=""
        onClick={(e) => {
          if (hasNestedInteractiveElement(e.target, e.currentTarget)) return;
          setOpen(true);
        }}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ cursor: 'pointer' }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </div>
      <Modal
        open={open}
        title={title}
        width={width}
        onCancel={() => setOpen(false)}
        footer={
          showDeleteButton ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button danger onClick={handleDelete}>
                {model.translate('Delete')}
              </Button>
            </div>
          ) : null
        }
        destroyOnClose
      >
        <FlowsSettings model={model} />
      </Modal>
    </>
  );
};

/**
 * Wraps flow model content in a Modal so flow settings are displayed as a dialog.
 * The modal opens when the wrapped content is clicked, matching the existing
 * 'dropdown' / 'contextMenu' variants while using Ant Design Modal conventions.
 * Only active when `flowSettingsEnabled` is true; otherwise renders children as-is.
 */
export const FlowsModalWrapper: React.FC<FlowsModalWrapperProps> = observer((props) => {
  const ctx = useFlowContext();
  if (!ctx.flowSettingsEnabled) {
    return <>{props.children}</>;
  }
  return <FlowsModalWrapperContent {...props} />;
});
FlowsModalWrapper.displayName = 'FlowsModalWrapper';
