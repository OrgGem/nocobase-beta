import { DashboardOutlined } from '@ant-design/icons';
import type { ISchema } from '@nocobase/client';
import {
  SchemaInitializerItem,
  useACLRoleContext,
  useSchemaInitializer,
  useSchemaInitializerItem,
} from '@nocobase/client';
import { Modal } from 'antd';
import React, { useCallback, useState } from 'react';

import { BuildForm } from './BuildForm';
import { useT } from './locale';
import { ACTIONS } from '../shared/constants';

/**
 * Block-menu item that launches the AI build flow.
 *
 * Unlike `plugin-visualization-templates`' initializer — which builds a schema
 * from a template registry the moment it is clicked — this initializer opens
 * the {@link BuildForm}. The form collects the collections, requirement, and
 * LLM settings, runs the asynchronous build, and (on confirm) hands back a
 * generated block schema which we insert into the active page/popup.
 *
 * Rendering notes:
 * - This renders as a plain clickable `SchemaInitializerItem` (collections are
 *   chosen inside the form, not in the menu, so `DataBlockInitializer`'s
 *   collection picker is not needed here).
 * - The schema-initializer item registration (task 10.3) must NOT pass
 *   `type: 'item'`, or the entry can fail to render as a clickable menu item
 *   (see plugin-setup-architecture-instructions.md). This component is designed
 *   to be that clickable item.
 *
 * Permission (Req 8.3): the item is hidden when the current role cannot perform
 * the plugin's build action. We resolve visibility with
 * `useACLRoleContext().parseAction`, mirroring how the reference initializer
 * derives its `filter`.
 */
export const BuildVisualizationBlockInitializer: React.FC = () => {
  const itemConfig = useSchemaInitializerItem();
  const { insert } = useSchemaInitializer();
  const { parseAction } = useACLRoleContext();
  const t = useT();
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  // Req 8.2: confirming a build inserts the generated schema, then closes.
  const handleInsert = useCallback(
    (schema: ISchema) => {
      setOpen(false);
      insert(schema);
    },
    [insert],
  );

  // Req 8.3: hide the menu item when the role lacks permission to the plugin's
  // build action (the ACL snippet action registered server-side).
  // `parseAction` returns the resolved action params when allowed, or a falsy
  // value when denied.
  if (!parseAction || !parseAction(ACTIONS.build)) {
    return null;
  }

  const title = itemConfig.title || t('Build Visualization Block');

  return (
    <>
      <SchemaInitializerItem {...itemConfig} title={title} icon={<DashboardOutlined />} onClick={handleOpen} />
      <Modal open={open} title={title} footer={null} destroyOnClose onCancel={handleClose} width={720}>
        {/* TODO(task 9.2): the real BuildForm may own its own modal/drawer; if
            so, move modal ownership into BuildForm and render it directly. The
            onInsert/onClose contract stays the same. */}
        <BuildForm onInsert={handleInsert} onClose={handleClose} />
      </Modal>
    </>
  );
};

export default BuildVisualizationBlockInitializer;
