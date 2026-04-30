import React from 'react';
import { SchemaComponentOptions } from '@nocobase/client';
import { UserGuideBlock } from './UserGuideBlock';
import { UserGuideBlockInitializer } from './UserGuideBlockInitializer';
import { SpaceSelect } from './components/SpaceSelect';

export const UserGuideBlockProvider = (props: any) => {
  return (
    <SchemaComponentOptions components={{ UserGuideBlock, UserGuideBlockInitializer, SpaceSelect }}>
      {props.children}
    </SchemaComponentOptions>
  );
};
