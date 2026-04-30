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
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_TARGET_CHAPTER_COUNT,
  MAX_TARGET_CHAPTER_COUNT,
  MIN_TARGET_CHAPTER_COUNT,
  spacesSchema,
} from './schemas/spacesSchema';
import { LLMServiceSelect } from './components/LLMServiceSelect';
import { ModelSelect } from './components/ModelSelect';
import { StatusTag } from './components/StatusTag';
import { BuildButton } from './components/BuildButton';

const normalizeTargetChapterCount = (value: unknown) => {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_TARGET_CHAPTER_COUNT;
  return Math.max(MIN_TARGET_CHAPTER_COUNT, Math.min(MAX_TARGET_CHAPTER_COUNT, Math.round(count)));
};

export const UserGuideManager = () => {
  const { t } = useTranslation();

  const useCreateFormProps = () => {
    const form = useMemo(
      () =>
        createForm({
          initialValues: {
            targetChapterCount: DEFAULT_TARGET_CHAPTER_COUNT,
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
          initialValues: {
            ...record,
            targetChapterCount: normalizeTargetChapterCount(record?.targetChapterCount),
          },
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

  const normalizeValues = (values: any) => {
    const { documents, ...rest } = values;
    rest.targetChapterCount = normalizeTargetChapterCount(rest.targetChapterCount);
    if (Array.isArray(documents)) {
      rest.documents = documents.map((doc: any) => (typeof doc === 'object' && doc?.id ? { id: doc.id } : doc));
    }
    return rest;
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
          await resource.create({ values: normalizeValues(form.values) });
          refresh();
          message.success(t('Saved successfully'));
          setVisible(false);
        } catch (err: any) {
          if (err?.name !== 'ValidateError') {
            message.error(err?.message || t('Save failed'));
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
            values: normalizeValues(form.values),
          });
          refresh();
          message.success(t('Saved successfully'));
          setVisible(false);
        } catch (err: any) {
          if (err?.name !== 'ValidateError') {
            message.error(err?.message || t('Save failed'));
          }
        }
      },
    };
  };

  return (
    <SchemaComponent
      schema={spacesSchema}
      components={{
        LLMServiceSelect,
        ModelSelect,
        StatusTag,
        BuildButton,
      }}
      scope={{
        t,
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
