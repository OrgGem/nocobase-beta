/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { Button, Drawer } from 'antd';
import { FlowModel } from '../../../../models';
import { useFlowContext } from '../../../..';
import { FlowsSettings } from '../embedded/FlowsSettings';
import { observer } from '../../../../reactive';

export interface FlowsDrawerWrapperProps {
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

const FlowsDrawerWrapperContent: React.FC<FlowsDrawerWrapperProps> = ({
  model,
  children,
  showDeleteButton,
  title,
  width = 520,
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
      <Drawer open={open} title={title} width={width} onClose={() => setOpen(false)} destroyOnClose>
        <FlowsSettings model={model} />
        {showDeleteButton && (
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Button danger onClick={handleDelete}>
              {model.translate('Delete')}
            </Button>
          </div>
        )}
      </Drawer>
    </>
  );
};

/**
 * Wraps flow model content in a Drawer so flow settings are displayed as a side panel.
 * The drawer opens when the wrapped content is clicked, matching the existing
 * 'dropdown' / 'contextMenu' variants while using Ant Design Drawer conventions.
 * Only active when `flowSettingsEnabled` is true; otherwise renders children as-is.
 */
export const FlowsDrawerWrapper: React.FC<FlowsDrawerWrapperProps> = observer((props) => {
  const ctx = useFlowContext();
  if (!ctx.flowSettingsEnabled) {
    return <>{props.children}</>;
  }
  return <FlowsDrawerWrapperContent {...props} />;
});
FlowsDrawerWrapper.displayName = 'FlowsDrawerWrapper';
