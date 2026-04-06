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
 * Root Cause: Formily's reactive observer re-renders the component during IME composition,
 * which interrupts the browser's native text composition (e.g., Vietnamese Telex/VNI input).
 *
 * Fix: Track composition state and defer onChange propagation to Formily until composition ends.
 * This pattern is consistent with flow-engine's FieldModelRenderer and VariableInput.
 */
import { LoadingOutlined } from '@ant-design/icons';
import { connect, mapProps, mapReadPretty } from '@formily/react';
import { Input as AntdInput } from 'antd';
import type { InputProps } from 'antd/es/input';
import React, { useCallback, useRef } from 'react';
import { Input as OriginalInput } from '@nocobase/client';

type NocoBaseInputProps = InputProps & {
  trim?: boolean;
  disableManualInput?: boolean;
  enableScan?: boolean;
};

/**
 * InputInner with IME composition handling.
 * Defers onChange propagation until onCompositionEnd to prevent
 * Formily's reactive re-render from interrupting browser IME composition.
 */
function IMESafeInputInner(props: NocoBaseInputProps) {
  const { onChange, trim, enableScan, ...others } = props;
  const composingRef = useRef(false);

  const handleChange = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      if (trim) {
        ev.target.value = ev.target.value.trim();
      }
      // During IME composition (e.g. Vietnamese Telex, Chinese Pinyin, Japanese),
      // do NOT propagate onChange to Formily. Formily's reactive observer would
      // re-render the component and interrupt the browser's native composition.
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
      // Composition is complete — now propagate the final value to Formily
      const inputEl = ev.target as HTMLInputElement;
      if (trim) {
        inputEl.value = inputEl.value.trim();
      }
      onChange?.(ev as unknown as React.ChangeEvent<HTMLInputElement>);
    },
    [onChange, trim],
  );

  const compositionProps = {
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
  };

  return <AntdInput {...others} {...compositionProps} onChange={handleChange} />;
}

IMESafeInputInner.displayName = 'Input';

// Access the ReadPretty.Input from the original connected Input
const OriginalReadPretty = (OriginalInput as any).ReadPretty;

/**
 * IME-safe Input connected component that replaces the core Input.
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
