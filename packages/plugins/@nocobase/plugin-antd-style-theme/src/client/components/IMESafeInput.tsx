/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * IME-safe Input component that fixes Vietnamese/CJK character composition issues.
 *
 * Root Cause (flow-engine path): FieldModelRenderer.handleChange calls
 * model.setProps({ value }) even during IME composition, which causes React to
 * re-render the controlled <Input> with the intermediate value, breaking the
 * browser's native text composition (e.g., Vietnamese Telex: "e" → "ê" becomes "e·ê·e").
 *
 * Root Cause (schema/Formily path): Formily's reactive observer re-renders during
 * IME composition, similarly interrupting composition.
 *
 * Fix: Maintain local state that diverges from the controlled `value` prop during
 * composition, making the input effectively uncontrolled while composing. On
 * compositionEnd, sync the final value back upstream.
 */
import { LoadingOutlined } from '@ant-design/icons';
import { connect, mapProps, mapReadPretty } from '@formily/react';
import { Input as AntdInput } from 'antd';
import type { InputProps } from 'antd/es/input';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Input as OriginalInput } from '@nocobase/client';

type NocoBaseInputProps = InputProps & {
  trim?: boolean;
  disableManualInput?: boolean;
  enableScan?: boolean;
};

/**
 * Core IME-safe input wrapper. Used by both the Formily-connected Input override
 * and the flow-engine InputFieldModel override.
 */
export function IMESafeInputInner(props: NocoBaseInputProps) {
  const { onChange, trim, enableScan, value, ...others } = props;
  const composingRef = useRef(false);
  const [localValue, setLocalValue] = useState<any>(value ?? '');

  // Sync from props when NOT composing.
  useEffect(() => {
    if (!composingRef.current) {
      setLocalValue(value ?? '');
    }
  }, [value]);

  const handleChange = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      let next = ev.target.value;
      if (trim && !composingRef.current) {
        next = next.trim();
        ev.target.value = next;
      }
      setLocalValue(next);
      if (composingRef.current) return;
      onChange?.(ev);
    },
    [onChange, trim],
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (ev: React.CompositionEvent<HTMLInputElement>) => {
      composingRef.current = false;
      const inputEl = ev.target as HTMLInputElement;
      let finalValue = inputEl.value;
      if (trim) {
        finalValue = finalValue.trim();
        inputEl.value = finalValue;
      }
      setLocalValue(finalValue);
      // Create a proper change event for upstream handlers
      const syntheticEvent = {
        ...ev,
        target: inputEl,
        currentTarget: inputEl,
        type: 'change',
      } as unknown as React.ChangeEvent<HTMLInputElement>;
      onChange?.(syntheticEvent);
    },
    [onChange, trim],
  );

  return (
    <AntdInput
      {...others}
      value={localValue}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onChange={handleChange}
    />
  );
}

IMESafeInputInner.displayName = 'Input';

// Access the ReadPretty.Input from the original connected Input
const OriginalReadPretty = (OriginalInput as any).ReadPretty;

/**
 * IME-safe Input connected component — overrides the core schema-based Input.
 * Only overrides the base Input (single-line text) — all sub-components
 * (TextArea, URL, JSON, ReadPretty, Preview) are preserved from the original.
 */
export const IMESafeInput = Object.assign(
  connect(
    IMESafeInputInner,
    mapProps((props, field) => {
      return {
        ...props,
        suffix: <span>{field?.['loading'] || field?.['validating'] ? <LoadingOutlined /> : props.suffix}</span>,
      };
    }),
    mapReadPretty(OriginalReadPretty),
  ),
  {
    // Preserve all sub-components from the original Input
    TextArea: (OriginalInput as any).TextArea,
    URL: (OriginalInput as any).URL,
    JSON: (OriginalInput as any).JSON,
    ReadPretty: OriginalReadPretty,
    Preview: (OriginalInput as any).Preview,
  },
);

IMESafeInput.displayName = 'Input';
