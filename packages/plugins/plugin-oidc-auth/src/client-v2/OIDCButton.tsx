import { useFlowContext } from '@nocobase/flow-engine';
import { AuthenticatorsContext } from '@nocobase/plugin-auth/client-v2';
import type { Authenticator } from '@nocobase/plugin-auth/client-v2';
import { Button, Space } from 'antd';
import Cookies from 'js-cookie';
import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { logoutCookieName } from '../constants';
import { useT } from './locale';

type AuthUrlResponse = { data?: { data?: unknown } };

export default function OIDCButton({ authenticator }: { authenticator: Authenticator }) {
  const t = useT();
  const ctx = useFlowContext();
  const location = useLocation();
  const authenticators = useContext(AuthenticatorsContext);
  const started = useRef(false);
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const redirect = params.get('redirect');
  const errorParam = params.get('error');
  const autoRedirectDisabled = params.get('oidc_auto_redirect') === 'off';
  const autoRedirectOwner = authenticators.find((item) => item.options?.autoLoginRedirect)?.name;

  const login = useCallback(async () => {
    const response = await ctx.api.request<AuthUrlResponse>({
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
  }, [authenticator.name, ctx.api, redirect, t]);

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
        ctx.message.error(error instanceof Error ? error.message : t('OIDC login failed.'));
      });
    }
  }, [authenticator.name, autoRedirectDisabled, autoRedirectOwner, ctx.message, errorParam, login, redirect, t]);

  useEffect(() => {
    if (params.get('authenticator') === authenticator.name && errorParam) ctx.message.error(t(errorParam));
  }, [authenticator.name, ctx.message, errorParam, params, t]);

  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      <Button block type="primary" shape="round" onClick={login}>
        {t(authenticator.title || 'Sign in with OIDC')}
      </Button>
    </Space>
  );
}
