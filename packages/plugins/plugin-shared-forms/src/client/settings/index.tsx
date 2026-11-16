// SPDX-License-Identifier: Apache-2.0

import {
  SchemaSettings,
  SchemaSettingsBlockTitleItem,
  SchemaSettingsLinkageRules,
  useCollection,
  SchemaSettingsRenderEngine,
} from '@nocobase/client';
import { useField } from '@formily/react';
import { useTranslation } from 'react-i18next';

export const sharedFormBlockSettings = new SchemaSettings({
  name: 'blockSettings:sharedForm',
  items: [
    {
      name: 'title',
      Component: SchemaSettingsBlockTitleItem,
    },
    {
      name: 'linkageRules',
      Component: SchemaSettingsLinkageRules,
      useComponentProps() {
        const { name } = useCollection();
        return {
          collectionName: name,
        };
      },
    },
  ],
});

export const sharedMarkdownBlockSettings = new SchemaSettings({
  name: 'blockSettings:sharedMarkdown',
  items: [
    {
      name: 'EditMarkdown',
      type: 'item',
      useComponentProps() {
        const field = useField();
        const { t } = useTranslation();

        return {
          title: t('Edit markdown'),
          onClick: () => {
            field.editable = true;
          },
        };
      },
    },
    {
      name: 'setBlockTemplate',
      Component: SchemaSettingsRenderEngine,
    },
  ],
});
