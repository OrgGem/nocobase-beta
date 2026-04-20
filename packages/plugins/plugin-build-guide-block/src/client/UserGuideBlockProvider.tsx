import React from 'react';
import { SchemaComponentOptions } from '@nocobase/client';
import { UserGuideBlock } from './UserGuideBlock';
import { UserGuideBlockInitializer } from './UserGuideBlockInitializer';

export const UserGuideBlockProvider = (props: any) => {
  return (
    <SchemaComponentOptions components={{ UserGuideBlock, UserGuideBlockInitializer }}>
      {props.children}
    </SchemaComponentOptions>
  );
};
