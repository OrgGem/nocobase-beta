// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import type { AxiosError, AxiosInstance, AxiosResponse } from 'axios';

const isRolesCheck = (url?: string) => {
  const path = url?.split(/[?#]/, 1)[0];
  return path === 'roles:check' || Boolean(path?.endsWith('/roles:check'));
};

/** Refresh the settings snapshot after the native ACL provider processes roles:check. */
export function useRolesCheckRefresh(api: { axios?: AxiosInstance }) {
  const [version, setVersion] = useState(0);
  const [valid, setValid] = useState(true);

  useEffect(() => {
    const interceptor = api.axios?.interceptors.response;
    if (!interceptor) return;

    let active = true;
    let sequence = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const id = interceptor.use(
      (response: AxiosResponse) => {
        if (active && isRolesCheck(response.config?.url)) {
          const current = ++sequence;
          const role = response.data?.data?.role;
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (active && current === sequence) {
              setValid(typeof role === 'string' && role.length > 0);
              setVersion((value) => value + 1);
            }
          }, 0);
          timers.add(timer);
        }
        return response;
      },
      (error: AxiosError) => {
        if (active && isRolesCheck(error?.config?.url)) {
          sequence += 1;
          setValid(false);
        }
        return Promise.reject(error);
      },
    );

    return () => {
      active = false;
      interceptor.eject(id);
      timers.forEach(clearTimeout);
    };
  }, [api]);

  return { version, valid };
}
