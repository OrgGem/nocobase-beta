// SPDX-License-Identifier: Apache-2.0

import { useContext } from 'react';
import { useForm, useFieldSchema, useField } from '@formily/react';
import { useDataBlockResource, useCollectValuesToSubmit, useFormBlockContext } from '@nocobase/client';
import { SharedFormMessageContext } from '../components/SharedFormPage';

export const useSharedSubmitActionProps = () => {
  const form = useForm();
  const resource = useDataBlockResource();
  const actionField = useField();
  const collectValues = useCollectValuesToSubmit();
  const actionSchema = useFieldSchema();
  const { updateAssociationValues } = useFormBlockContext();
  const { setShowMessage } = useContext(SharedFormMessageContext);
  return {
    type: 'primary',
    async onClick() {
      const { skipValidator, triggerWorkflows } = actionSchema?.['x-action-settings'] ?? {};
      if (!skipValidator) {
        await form.submit();
      }
      const values = await collectValues();
      actionField.data = actionField.data || {};
      actionField.data.loading = true;
      try {
        await form.submit();
        await resource.sharedSubmit({
          values,
          triggerWorkflows: triggerWorkflows?.length
            ? triggerWorkflows.map((row) => [row.workflowKey, row.context].filter(Boolean).join('!')).join(',')
            : undefined,
          updateAssociationValues,
        });
        await form.reset();
        actionField.data.loading = false;
        setShowMessage(true);
      } catch (error) {
        actionField.data.loading = false;
      }
    },
  };
};
