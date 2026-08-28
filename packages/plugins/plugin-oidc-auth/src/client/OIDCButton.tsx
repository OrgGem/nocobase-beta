import { css, Icon, useAPIClient } from '@nocobase/client';
import { Authenticator, AuthenticatorsContext } from "@nocobase/plugin-auth";
import { Button, Space, message } from 'antd';
import Cookies from 'js-cookie';
import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { logoutCookieName } from '../constants';
import { useOidcTranslation } from './locale';

type AuthUrlResponse = { data?: { data?: unknown } };

export const OIDCButton = ({ authenticator }: { authenticator: Authenticator }) => {
  const { t } = useOidcTranslation();
  const api = useAPIClient();
  const location = useLocation();
  const authenticators = useContext(AuthenticatorsContext);
  const started = useRef(false);
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const redirect = params.get('redirect');
  const errorParam = params.get('error');
  const autoRedirectDisabled = params.get('oidc_auto_redirect') === 'off';
  const autoRedirectOwner = authenticators.find((item) => item.options?.autoLoginRedirect)?.name;

  const login = useCallback(async () => {
    const response = await api.request<AuthUrlResponse>({
      method: 'post',
      url: 'oidc:getAuthUrl',
      headers: { 'X-Authenticator': authenticator.name },
      data: { redirect },
    });
    const authUrl = response.data?.data;
    if (typeof authUrl !== 'string' || !/^https?:\/\//i.test(authUrl)) {
      throw new Error(t('The identity provider returned an invalid authorization URL.'));
    }
    window.location.replace(authUrl);
  }, [api, authenticator.name, redirect, t]);

  useEffect(() => {
    const logoutUrl = Cookies.get(logoutCookieName);
    if (!errorParam && logoutUrl) {
      Cookies.remove(logoutCookieName);
      window.location.replace(logoutUrl);
      return;
    }
    if (
      !started.current &&
      !errorParam &&
      !autoRedirectDisabled &&
      redirect != null &&
      autoRedirectOwner === authenticator.name
    ) {
      started.current = true;
      login().catch((error: unknown) => {
        started.current = false;
        message.error(error instanceof Error ? error.message : t('OIDC login failed.'));
      });
    }
  }, [authenticator.name, autoRedirectDisabled, autoRedirectOwner, errorParam, login, redirect, t]);

  useEffect(() => {
    const name = params.get('authenticator');
    const error = params.get('error');
    if (name === authenticator.name && error) message.error(t(error));
  }, [authenticator.name, location.search, params, t]);

  const btnStyle = authenticator.options?.buttonStyle;
  return (
    <Space
      direction="vertical"
      className={css`
        display: flex;
      `}
    >
      <Button
        block
        onClick={login}
        icon={<Icon type={btnStyle?.icon} />}
        type={btnStyle?.type}
        shape={btnStyle?.shape ?? 'round'}
        color={btnStyle?.color}
        variant={btnStyle?.variant}
        style={btnStyle?.customStyle?.reduce(
          (styles: React.CSSProperties, item: { property: string; value: string }) => ({
            ...styles,
            [item.property]: item.value,
          }),
          {},
        )}
      >
        {t(authenticator.title)}
      </Button>
    </Space>
  );
};

export default OIDCButton;

