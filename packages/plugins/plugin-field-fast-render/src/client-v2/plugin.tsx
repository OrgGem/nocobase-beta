import { Plugin, TableColumnModel } from '@nocobase/client-v2';
import { patchTableColumnFastRender, isSupportedFastRenderField } from './fastRender';
import { tExpr } from './locale';

type FlowRuntimeContextLike = {
  model: TableColumnModel & {
    collectionField?: unknown;
    props?: Record<string, unknown>;
    setProps?: (props: Record<string, unknown>) => void;
  };
};

const FLOW_KEY = 'fieldFastRenderSettings';
const FLOW_REGISTERED = Symbol.for('plugin-field-fast-render.TableColumnModel.flow.registered');

type TableColumnModelWithFlowGuard = typeof TableColumnModel & {
  [FLOW_REGISTERED]?: boolean;
};

function registerFastRenderFlow() {
  const tableColumnModel = TableColumnModel as TableColumnModelWithFlowGuard;
  if (tableColumnModel[FLOW_REGISTERED]) {
    return;
  }

  tableColumnModel.registerFlow({
    key: FLOW_KEY,
    sort: 506,
    steps: {
      fastRender: {
        title: tExpr('Fast render'),
        uiMode: { type: 'switch', key: 'fastRender' },
        hideInSettings(ctx: FlowRuntimeContextLike) {
          return !isSupportedFastRenderField(ctx.model);
        },
        defaultParams: {
          fastRender: false,
        },
        handler(ctx: FlowRuntimeContextLike, params: { fastRender?: boolean }) {
          ctx.model.setProps?.({ fastRender: params.fastRender === true });
        },
      },
    },
  });
  tableColumnModel[FLOW_REGISTERED] = true;
}

export class PluginFieldFastRenderClient extends Plugin {
  async load() {
    patchTableColumnFastRender(TableColumnModel);
    registerFastRenderFlow();
  }
}

export default PluginFieldFastRenderClient;
