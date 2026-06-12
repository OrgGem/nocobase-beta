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
import { DEFAULT_MAPPING, DEFAULT_SETTINGS } from '../../shared/constants';
import { useT } from '../locale';
import { categoriesSchema } from '../schemas/categoriesSchema';

export const CategoriesManager = () => {
  const t = useT();
  const useCreateFormProps = () => {
    const form = useMemo(
      () =>
        createForm({
          initialValues: {
            enabled: true,
            acceptStatus: DEFAULT_SETTINGS.acceptStatus,
            rejectStatus: DEFAULT_SETTINGS.rejectStatus,
            callbackTimeoutMs: DEFAULT_SETTINGS.callbackTimeoutMs,
            itemsPath: DEFAULT_MAPPING.itemsPath,
            idPath: DEFAULT_MAPPING.idPath,
            keyPath: DEFAULT_MAPPING.keyPath,
            valuePath: DEFAULT_MAPPING.valuePath,
            pagePath: DEFAULT_MAPPING.pagePath,
            rectPath: DEFAULT_MAPPING.rectPath,
            pointsPath: DEFAULT_MAPPING.pointsPath,
            confidencePath: DEFAULT_MAPPING.confidencePath,
            statusPath: DEFAULT_MAPPING.statusPath,
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
          message.success(t('Category created successfully'));
          setVisible(false);
        } catch (err: any) {
          if (err?.name !== 'ValidateError') {
            message.error(err?.message || t('Failed to create category'));
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
          message.success(t('Category updated successfully'));
          setVisible(false);
        } catch (err: any) {
          if (err?.name !== 'ValidateError') {
            message.error(err?.message || t('Failed to update category'));
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
