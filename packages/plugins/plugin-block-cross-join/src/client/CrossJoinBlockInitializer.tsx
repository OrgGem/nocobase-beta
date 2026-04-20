/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { MergeCellsOutlined } from '@ant-design/icons';
import { SchemaInitializerItem, useSchemaInitializer, useSchemaInitializerItem } from '@nocobase/client';
import { CrossJoinConfigurator } from './CrossJoinConfigurator';
import { createCrossJoinBlockUISchema } from './createBlockUISchema';

export const CrossJoinBlockInitializer: React.FC = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();
  const [visible, setVisible] = useState(false);

  return (
    <>
      <SchemaInitializerItem {...itemConfig} icon={<MergeCellsOutlined />} onClick={() => setVisible(true)} />
      <CrossJoinConfigurator
        visible={visible}
        onCancel={() => setVisible(false)}
        onSubmit={(config) => {
          insert(createCrossJoinBlockUISchema(config));
          setVisible(false);
        }}
      />
    </>
  );
};
