/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  ExtendCollectionsProvider,
  SchemaComponent,
  usePlugin,
  SchemaComponentContext,
  useSchemaComponentContext,
} from '@nocobase/client';
import React, { useMemo } from 'react';
import PluginSharedFormsClient from '..';
import { sharedFormsCollection } from '../collections';
import { useDeleteActionProps, useEditFormProps, useSubmitActionProps } from '../hooks';
import { sharedFormsSchema } from '../schemas';

export const AdminSharedFormList = () => {
  const plugin = usePlugin(PluginSharedFormsClient);
  const scCtx = useSchemaComponentContext();
  const formTypes = useMemo(() => plugin.getFormTypeOptions(), [plugin]);
  return (
    <ExtendCollectionsProvider collections={[sharedFormsCollection]}>
      <SchemaComponentContext.Provider value={{ ...scCtx, designable: false }}>
        <SchemaComponent
          schema={sharedFormsSchema}
          scope={{ formTypes, useSubmitActionProps, useEditFormProps, useDeleteActionProps }}
        />
      </SchemaComponentContext.Provider>
    </ExtendCollectionsProvider>
  );
};
