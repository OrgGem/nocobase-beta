import React from 'react';
import { useSystemSettings } from '@nocobase/client-v2';

export const HelpVisibilityProviderV2: React.FC<React.PropsWithChildren<{}>> = (props) => {
  const systemSettings = useSystemSettings();
  const showHelp = systemSettings?.data?.data?.options?.showHelp !== false;

  return (
    <>
      {!showHelp && (
        <style>{`
          div:has(> [data-testid="help-button"]) {
            display: none !important;
          }
        `}</style>
      )}
      {props.children}
    </>
  );
};

export default HelpVisibilityProviderV2;
