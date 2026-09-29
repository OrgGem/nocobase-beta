import React from 'react';
import { FieldModel } from '@nocobase/client-v2';
import { DisplayItemModel } from '@nocobase/flow-engine';
import { tExpr } from '../locale';

export class DisplayVietnamRegionFieldModel extends FieldModel {
  render() {
    const { value } = this.props;

    if (!value || (Array.isArray(value) && value.length === 0)) {
      return null;
    }

    if (Array.isArray(value)) {
      const sorted = [...value].sort((left, right) => {
        if (left.level !== right.level) {
          return left.level - right.level;
        }
        return (left.sort || 0) - (right.sort || 0);
      });
      const names = sorted.map((item) => item.name || item.label || item).filter(Boolean);
      return <span>{names.join('/')}</span>;
    }

    if (typeof value === 'object' && value.name) {
      return <span>{value.name}</span>;
    }

    return <span>{String(value)}</span>;
  }
}

DisplayVietnamRegionFieldModel.define({
  label: tExpr('Vietnam region'),
});

DisplayItemModel.bindModelToInterface('DisplayVietnamRegionFieldModel', ['vietnamRegion'], { isDefault: true });
