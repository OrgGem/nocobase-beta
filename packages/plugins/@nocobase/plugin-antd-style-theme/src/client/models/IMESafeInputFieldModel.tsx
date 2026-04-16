/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Override of core InputFieldModel that renders an IME-safe Input.
 *
 * The core FieldModelRenderer calls model.setProps({ value }) during IME
 * composition, which causes a controlled <Input> to re-render and break
 * Vietnamese/CJK character composition. This override renders an
 * IMESafeInputInner that maintains local state during composition, preventing
 * the upstream value from overwriting the DOM mid-composition.
 */
import React from 'react';
import { InputFieldModel } from '@nocobase/client';
import { IMESafeInputInner } from '../components/IMESafeInput';

export class IMESafeInputFieldModel extends InputFieldModel {
  render() {
    return <IMESafeInputInner {...this.props} />;
  }
}
