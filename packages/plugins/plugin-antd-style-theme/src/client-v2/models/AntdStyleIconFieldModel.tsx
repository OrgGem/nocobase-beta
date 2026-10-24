import { IconFieldModel } from '@nocobase/client-v2';
import React from 'react';
import { NativeIconPicker } from '../components/IconPicker';

export class AntdStyleIconFieldModel extends IconFieldModel {
  render() {
    return <NativeIconPicker {...this.props} />;
  }
}
