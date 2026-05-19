import React, { useMemo } from 'react';
import {
  SchemaComponent,
  useActionContext,
  useCollectionRecordData,
  useDataBlockRequest,
  useDataBlockResource,
  useDestroyActionProps,
  useTableBlockProps,
} from '@nocobase/client';
import { createForm } from '@formily/core';
import { useForm } from '@formily/react';
import { App } from 'antd';
import { categoriesSchema } from '../schemas/categoriesSchema';

export const CategoriesManager = () => {
  const useCreateFormProps = () => {
    const form = useMemo(
      () =>
        createForm({
          initialValues: {
            enabled: true,
            acceptStatus: 'accepted',
            rejectStatus: 'rejected',
          },
        }),
      [],
    );
    return { form };
  };

  const useEditFormProps = () => {
    const record = useCollectionRecordData();
    const form = useMemo(
      () =>
        createForm({
          initialValues: record,
        }),
      [record],
    );
    return { form };
  };

  const useCancelActionProps = () => {
    const { setVisible } = useActionContext();
    return {
      type: 'default',
      onClick() {
        setVisible(false);
      },
    };
  };

  const useCreateActionProps = () => {
    const { setVisible } = useActionContext();
    const { message } = App.useApp();
    const resource = useDataBlockResource();
    const { refresh } = useDataBlockRequest();
    const form = useForm();

    return {
      type: 'primary',
      async onClick() {
        try {
          await form.submit();
          await resource.create({ values: form.values });
          refresh();
          message.success('Category created successfully');
          setVisible(false);
        } catch (err: any) {
          if (err?.name !== 'ValidateError') {
            message.error(err?.message || 'Failed to create category');
          }
        }
      },
    };
  };

  const useUpdateActionProps = () => {
    const { setVisible } = useActionContext();
    const { message } = App.useApp();
    const resource = useDataBlockResource();
    const { refresh } = useDataBlockRequest();
    const record = useCollectionRecordData();
    const form = useForm();

    return {
      type: 'primary',
      async onClick() {
        try {
          await form.submit();
          await resource.update({
            filterByTk: record.id,
            values: form.values,
          });
          refresh();
          message.success('Category updated successfully');
          setVisible(false);
        } catch (err: any) {
          if (err?.name !== 'ValidateError') {
            message.error(err?.message || 'Failed to update category');
          }
        }
      },
    };
  };

  return (
    <SchemaComponent
      schema={categoriesSchema}
      components={{}}
      scope={{
        useCreateFormProps,
        useEditFormProps,
        useCancelActionProps,
        useCreateActionProps,
        useUpdateActionProps,
        useDestroyActionProps,
        useTableBlockProps,
      }}
    />
  );
};
