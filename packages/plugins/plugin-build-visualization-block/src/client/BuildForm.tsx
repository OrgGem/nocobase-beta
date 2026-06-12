import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Spin, Typography } from 'antd';
import { ISchema, useAPIClient, useApp } from '@nocobase/client';
import { createForm } from '@formily/core';
import { Field, FormProvider } from '@formily/react';

import {
  CollectionMultiSelect,
  CollectionMultiSelectValue,
  LLMServiceSelect,
  ModelSelect,
  BuildPhaseTag,
} from './components';
import { PreviewPanel } from './PreviewPanel';
import { useBuildPolling } from './hooks/useBuildPolling';
import { useT } from './locale';
import { COLLECTION_NAME, MAX_COLLECTIONS, MAX_REQUIREMENT_CHARS, SETTINGS_COLLECTION_NAME } from '../shared/constants';

/**
 * Props consumed by {@link BuildForm}.
 *
 * This is the stable seam between the block initializer (task 10.2) and the
 * full build form (task 9.2). The initializer hosts the form inside a modal and
 * passes:
 * - `onInsert` — called with the generated Formily block schema once the user
 *   confirms a build; the initializer forwards it to `useSchemaInitializer().insert`.
 * - `onClose` — called when the form is dismissed without inserting anything.
 *
 * `BuildForm` renders only the form/flow body (no modal of its own) because the
 * initializer already owns the surrounding `Modal`.
 */
export type BuildFormProps = {
  /** Insert the generated block schema into the active page/popup. */
  onInsert: (schema: ISchema) => void;
  /** Dismiss the form without inserting. */
  onClose: () => void;
};

/**
 * Client-side validation errors keyed by the field they belong to. A missing
 * key means that field is currently valid.
 */
interface FormErrors {
  requirement?: string;
  collections?: string;
  ai?: string;
  /** A submit-time error not tied to a single field (e.g. request failure). */
  submit?: string;
}

/**
 * Read a string value out of the (loosely-typed) Formily `form.values` bag
 * without leaking `any` into call sites.
 */
function readStringValue(values: unknown, key: string): string {
  if (values && typeof values === 'object') {
    const candidate = (values as Record<string, unknown>)[key];
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return '';
}

/**
 * Safely pull the created build record id out of the `build` action response.
 * NocoBase action responses are double-wrapped (`res.data.data`), so both
 * levels are checked structurally and the id is normalized to a string.
 */
function extractBuildId(res: unknown): string | undefined {
  if (res && typeof res === 'object') {
    const outer = (res as { data?: unknown }).data;
    if (outer && typeof outer === 'object') {
      const body = (outer as { data?: unknown }).data;
      if (body && typeof body === 'object') {
        const id = (body as { id?: unknown }).id;
        if (typeof id === 'string' || typeof id === 'number') {
          return String(id);
        }
      }
    }
  }
  return undefined;
}

interface BuildDefaults {
  defaultDataSource?: string;
  defaultCollections?: string[];
  defaultLLMService?: string;
  defaultModel?: string;
}

function normalizeDefaults(value: unknown): BuildDefaults {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    defaultDataSource: typeof source.defaultDataSource === 'string' ? source.defaultDataSource : undefined,
    defaultCollections: Array.isArray(source.defaultCollections)
      ? source.defaultCollections.filter((item): item is string => typeof item === 'string')
      : [],
    defaultLLMService: typeof source.defaultLLMService === 'string' ? source.defaultLLMService : undefined,
    defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel : undefined,
  };
}

/**
 * The natural-language build form (Req 1.4, 1.6, 3.1, 3.2, 3.3, 4.3, 4.4).
 *
 * Field-wiring decision: the two AI selectors (`LLMServiceSelect`,
 * `ModelSelect`) rely on Formily context — `ModelSelect` observes
 * `form.values.llmService` and `LLMServiceSelect` resets the sibling `.model`
 * field — so they are rendered inside a small Formily `FormProvider` whose
 * values expose `llmService`/`model`. The `requirement` textarea and the
 * data-source/collections picker (`CollectionMultiSelect`, an object-valued
 * controlled component) are kept in plain React state, which is both simpler
 * and avoids awkwardly adapting an object-valued field into Formily. This is
 * the cleaner of the two approaches the design allows.
 *
 * Flow: idle/editing → (submit) building → completed (preview) | failed (retry).
 */
export const BuildForm: React.FC<BuildFormProps> = ({ onInsert, onClose }) => {
  const t = useT();
  const api = useAPIClient();
  const app = useApp();

  // Formily form backing the AI selectors only (llmService + model).
  const form = useMemo(() => createForm(), []);

  // Plain-state fields.
  const [requirement, setRequirement] = useState('');
  const [collectionValue, setCollectionValue] = useState<CollectionMultiSelectValue>({
    collections: [],
  });
  const [errors, setErrors] = useState<FormErrors>({});

  // Build lifecycle state.
  const [buildId, setBuildId] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  // `building` drives the in-progress view and is also the polling switch. It
  // is set on submit/retry and cleared once the build reaches a terminal phase.
  const [building, setBuilding] = useState(false);

  const { phase, record } = useBuildPolling(buildId, {
    enabled: Boolean(buildId) && building,
  });

  // Stop polling and leave the building view once the build is terminal.
  useEffect(() => {
    if (phase === 'completed' || phase === 'failed') {
      setBuilding(false);
    }
  }, [phase]);

  useEffect(() => {
    let active = true;

    const loadDefaults = async () => {
      try {
        const response = await api.resource(SETTINGS_COLLECTION_NAME).publicGet();
        if (!active) {
          return;
        }
        const defaults = normalizeDefaults((response as { data?: { data?: unknown } }).data?.data);
        setCollectionValue({
          dataSource: defaults.defaultDataSource,
          collections: defaults.defaultCollections ?? [],
        });
        form.setValues({
          llmService: defaults.defaultLLMService,
          model: defaults.defaultModel,
        });
      } catch (error) {
        console.warn('[plugin-build-visualization-block] Failed to load default settings:', error);
      }
    };

    loadDefaults();
    return () => {
      active = false;
    };
  }, [api, form]);

  // AI availability (Req 4.4): the build needs the AI plugin to be present.
  const aiAvailable = useMemo<boolean>(() => {
    const pm = app.pm;
    return Boolean(pm.get('ai') || pm.get('@nocobase/plugin-ai') || pm.get('plugin-ai'));
  }, [app]);

  const dataSource = collectionValue.dataSource;
  const collections = useMemo(() => collectionValue.collections ?? [], [collectionValue]);

  /** Validate the editable inputs; returns the collected errors. */
  const validate = useCallback((): FormErrors => {
    const next: FormErrors = {};

    const trimmedRequirement = requirement.trim();
    if (!trimmedRequirement) {
      next.requirement = t('Requirement description is required');
    } else if (requirement.length > MAX_REQUIREMENT_CHARS) {
      next.requirement = t('Requirement must be at most {{max}} characters', {
        max: MAX_REQUIREMENT_CHARS,
      });
    }

    if (collections.length < 1) {
      next.collections = t('At least one collection is required');
    } else if (collections.length > MAX_COLLECTIONS) {
      next.collections = t('You can select at most {{max}} collections', {
        max: MAX_COLLECTIONS,
      });
    }

    const llmService = readStringValue(form.values, 'llmService');
    const model = readStringValue(form.values, 'model');
    if (!llmService || !model) {
      next.ai = t('AI service and model are required');
    }

    return next;
  }, [requirement, collections, form, t]);

  const handleSubmit = useCallback(async () => {
    // Re-validate AI availability defensively (Req 4.4).
    if (!aiAvailable) {
      return;
    }

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      // Retain values; surface inline messages (Req 1.4/1.6/3.2/3.3/4.3).
      setErrors(validationErrors);
      return;
    }
    setErrors({});

    const values = {
      requirement: requirement.trim(),
      dataSource,
      collections,
      primaryCollection: collections[0],
      llmService: readStringValue(form.values, 'llmService'),
      model: readStringValue(form.values, 'model'),
    };

    setSubmitting(true);
    try {
      const res = await api.resource(COLLECTION_NAME).build({ values });
      const id = extractBuildId(res);
      if (!id) {
        setErrors({ submit: t('The requirement could not be saved') });
        return;
      }
      setBuildId(id);
      setBuilding(true);
    } catch {
      setErrors({ submit: t('The requirement could not be saved') });
    } finally {
      setSubmitting(false);
    }
  }, [aiAvailable, validate, requirement, dataSource, collections, form, api, t]);

  // Regenerate/Retry: re-queue the same record and resume polling its id.
  const handleRegenerate = useCallback(async () => {
    if (!buildId) {
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await api.resource(COLLECTION_NAME).retry({ filterByTk: buildId });
      setBuilding(true);
    } catch (error) {
      setErrors({ submit: t('The requirement could not be saved') });
    } finally {
      setSubmitting(false);
    }
  }, [api, buildId, t]);

  // ---- Completed: render the preview. -------------------------------------
  if (buildId && !building && phase === 'completed' && record) {
    return (
      <PreviewPanel
        schema={record.blockSchema as ISchema}
        usedFallback={record.usedFallback}
        adjustments={record.adjustments}
        onInsert={onInsert}
        onRegenerate={handleRegenerate}
        onCancel={onClose}
        loading={false}
      />
    );
  }

  // ---- Failed: show the error and offer a retry. --------------------------
  if (buildId && !building && phase === 'failed') {
    return (
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert type="error" showIcon message={record?.errorMessage || t('The requirement could not be saved')} />
        <Space>
          <Button type="primary" onClick={handleRegenerate} loading={submitting}>
            {t('Retry')}
          </Button>
          <Button onClick={onClose}>{t('Cancel')}</Button>
        </Space>
      </Space>
    );
  }

  // ---- Building: show the current phase + a spinner. ----------------------
  if (buildId && building) {
    return (
      <Space direction="vertical" align="center" style={{ width: '100%', padding: 24 }} size="middle">
        <Spin aria-label={t('Generating')} />
        <Space>
          <BuildPhaseTag value={phase} />
          <Typography.Text type="secondary">{t('Generating')}</Typography.Text>
        </Space>
      </Space>
    );
  }

  // ---- Idle/editing: render the form. -------------------------------------
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {!aiAvailable ? <Alert type="warning" showIcon message={t('The AI service is unavailable')} /> : null}

      <div>
        <Typography.Text strong>{t('Requirement')}</Typography.Text>
        <Input.TextArea
          aria-label={t('Requirement')}
          placeholder={t('Describe the block you want to build')}
          value={requirement}
          onChange={(event) => setRequirement(event.target.value)}
          showCount
          maxLength={MAX_REQUIREMENT_CHARS}
          autoSize={{ minRows: 3, maxRows: 8 }}
          status={errors.requirement ? 'error' : undefined}
        />
        {errors.requirement ? <Typography.Text type="danger">{errors.requirement}</Typography.Text> : null}
      </div>

      <div>
        <Typography.Text strong>{t('Collections')}</Typography.Text>
        <CollectionMultiSelect value={collectionValue} onChange={setCollectionValue} />
        {errors.collections ? <Typography.Text type="danger">{errors.collections}</Typography.Text> : null}
      </div>

      <FormProvider form={form}>
        <div>
          <Typography.Text strong>{t('AI service')}</Typography.Text>
          <Field
            name="llmService"
            component={[LLMServiceSelect, { placeholder: t('AI service'), style: { width: '100%' } }]}
          />
        </div>
        <div>
          <Typography.Text strong>{t('Model')}</Typography.Text>
          <Field name="model" component={[ModelSelect, { placeholder: t('Model'), style: { width: '100%' } }]} />
        </div>
      </FormProvider>

      {errors.ai ? <Typography.Text type="danger">{errors.ai}</Typography.Text> : null}
      {errors.submit ? <Alert type="error" showIcon message={errors.submit} /> : null}

      <Space>
        <Button type="primary" onClick={handleSubmit} loading={submitting} disabled={!aiAvailable}>
          {t('Build')}
        </Button>
        <Button onClick={onClose} disabled={submitting}>
          {t('Cancel')}
        </Button>
      </Space>
    </Space>
  );
};

export default BuildForm;
