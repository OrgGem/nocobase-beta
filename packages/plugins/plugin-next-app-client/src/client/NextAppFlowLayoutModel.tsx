import { BaseLayoutModel, getLayoutModel, type GetLayoutModelOptions } from '@nocobase/client-v2';
import { type FlowEngine, FlowModel, observer } from '@nocobase/flow-engine';
import React, { PropsWithChildren, useCallback, useEffect } from 'react';

export const NEXT_APP_LAYOUT_MODEL_CLASS = 'NextAppLayoutModel';
export const NEXT_APP_LAYOUT_MODEL_UID = 'next-app-layout-model';

const NextAppLayoutComponent = observer((props: PropsWithChildren<{ model: NextAppLayoutModel }>) => {
  const { children, model } = props;
  const handleLayoutContentElementChange = useCallback(
    (element: HTMLDivElement | null) => {
      model.setLayoutContentElement(element);
    },
    [model],
  );

  useEffect(() => {
    model.setIsMobileLayout(false);
  }, [model]);

  return (
    <div
      ref={handleLayoutContentElementChange}
      style={{
        height: 'calc(100vh - var(--nb-header-height))',
        minHeight: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
      data-next-app-page-uid={model.props.pageUid}
    >
      {children}
    </div>
  );
});

export class NextAppLayoutModel extends BaseLayoutModel {
  render() {
    return (
      <NextAppLayoutComponent {...this.props} model={this}>
        {this.props.children}
      </NextAppLayoutComponent>
    );
  }
}

export function getNextAppLayoutModel<TModel extends FlowModel = NextAppLayoutModel>(
  flowEngine: FlowEngine,
  options: GetLayoutModelOptions<TModel> = {},
) {
  return getLayoutModel<TModel>(flowEngine, NEXT_APP_LAYOUT_MODEL_UID, {
    ...options,
    use: (options.use || NextAppLayoutModel) as any,
  });
}
