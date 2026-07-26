#!/bin/sh

set -eu

APP_ROOT='/app/nocobase'
STORAGE_ROOT="${APP_ROOT}/storage"
READINESS_URL="${APP_START_AFTER_URL:-${WORKER_READY_URL:-${CLUSTER_MANAGER_WORKER_READY_URL:-}}}"

install_git_if_missing() {
  if command -v git >/dev/null 2>&1; then
    return
  fi

  echo '[runtime] git is missing; installing it for Git-backed plugins'
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y --no-install-recommends git
    rm -rf /var/lib/apt/lists/*
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache git
  else
    echo '[runtime] no supported package manager is available to install git' >&2
    exit 1
  fi
}

prepare_app_source() {
  if [ ! -d "${APP_ROOT}" ]; then
    mkdir -p "${APP_ROOT}"
  fi

  if [ ! -f "${APP_ROOT}/package.json" ]; then
    echo '[runtime] extracting the bundled NocoBase source'
    tar -zxf /app/nocobase.tar.gz --absolute-names -C "${APP_ROOT}"
    touch "${APP_ROOT}/node_modules/@nocobase/app/dist/client/index.html"
  fi

  cd "${APP_ROOT}"
  # The production deployment uses a local license shim for this self-hosted stack.
  echo "module.exports={getEnvAsync:async()=>({sys:'mock',osVer:'mock',db:{id:'mock'}}),getInstanceIdWithPublicKeyAsync:async()=>'mock',getInstanceIdAsync:async()=>'mock',instanceIdDecrypt:()=>'mock',createKeyPair:()=>({publicKey:'mock',privateKey:'mock'}),encryptWithPublicKey:()=>'mock',encrypt:()=>'mock',decryptWithPrivateKey:()=>'mock',createSignature:()=>'mock',verifySignature:()=>true,keyEncrypt:()=>'mock',keyDecrypt:()=>JSON.stringify({licenseKey:{domain:'*'}})}" > node_modules/@nocobase/license-kit/index.js
}

predecessor_is_ready() {
  node <<'NODE'
const http = require('http');
const expected = (process.env.NOCOBASE_IMAGE_VERSION || '').replace(/-full$/, '');
const request = http.get(process.env.READINESS_URL, (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const version = payload && payload.data && payload.data.version;
      const expectedIsSemver = /^\d+\.\d+\.\d+$/.test(expected);
      const valid = response.statusCode === 200 && typeof version === 'string' && version.length > 0;
      process.exit(valid && (!expectedIsSemver || version === expected) ? 0 : 1);
    } catch (_error) {
      process.exit(1);
    }
  });
});
request.setTimeout(5000, () => { request.destroy(); process.exit(1); });
request.on('error', () => process.exit(1));
NODE
}

is_non_negative_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

wait_for_predecessor() {
  max_wait_seconds="$1"
  interval_seconds="$2"
  if [ -z "${READINESS_URL}" ]; then
    echo '[runtime] readiness URL is required' >&2
    return 1
  fi
  if ! is_non_negative_integer "${max_wait_seconds}" || ! is_non_negative_integer "${interval_seconds}" || [ "${interval_seconds}" -eq 0 ]; then
    echo '[runtime] readiness timeout and interval must be positive integers' >&2
    return 1
  fi
  echo "[runtime] waiting for predecessor readiness at ${READINESS_URL}"
  waited=0
  while ! predecessor_is_ready; do
    if [ "${max_wait_seconds}" -gt 0 ] && [ "${waited}" -ge "${max_wait_seconds}" ]; then
      echo "[runtime] readiness timed out after ${waited}s; refusing to start" >&2
      return 1
    fi
    waited=$((waited + interval_seconds))
    if [ $(((waited / interval_seconds) % 12)) -eq 0 ]; then
      echo "[runtime] predecessor is not ready yet (${waited}s elapsed)"
    fi
    sleep "${interval_seconds}"
  done
  echo '[runtime] predecessor is ready'
}

run_full_upgrade() {
  upgrade_log="$(mktemp)"
  echo '[runtime] app-main: pending upgrade marker found; running full upgrade'

  # `nocobase upgrade` can finish database migration but remain alive because a
  # third-party plugin leaves a background handle open during its internal
  # restart. Isolate it in a session so the completed CLI process can be
  # stopped without affecting the entrypoint or the subsequent app server.
  if command -v setsid >/dev/null 2>&1; then
    setsid yarn nocobase upgrade >"${upgrade_log}" 2>&1 &
    upgrade_pid=$!
    upgrade_group=true
  else
    yarn nocobase upgrade >"${upgrade_log}" 2>&1 &
    upgrade_pid=$!
    upgrade_group=false
  fi

  while kill -0 "${upgrade_pid}" 2>/dev/null; do
    if grep -q 'NocoBase has been upgraded' "${upgrade_log}"; then
      echo '[runtime] app-main: full upgrade completed; stopping stale CLI process'
      if [ "${upgrade_group}" = true ]; then
        kill -TERM "-${upgrade_pid}" 2>/dev/null || true
      else
        kill -TERM "${upgrade_pid}" 2>/dev/null || true
      fi
      wait "${upgrade_pid}" 2>/dev/null || true
      cat "${upgrade_log}"
      rm -f "${upgrade_log}"
      return 0
    fi
    sleep 1
  done

  wait "${upgrade_pid}"
  upgrade_status=$?
  cat "${upgrade_log}"
  rm -f "${upgrade_log}"
  return "${upgrade_status}"
}

install_git_if_missing
prepare_app_source

case "${APP_NODE_ROLE:-backup}" in
  main)
    cd "${APP_ROOT}"
    echo '[runtime] app-main: verifying installation'
    yarn nocobase install

    if [ -e "${STORAGE_ROOT}/.upgrading" ]; then
      run_full_upgrade
    else
      echo '[runtime] app-main: checking package/database version'
      SKIP_SAME_VERSION_UPGRADE=true yarn nocobase upgrade
    fi

    # A direct `yarn nocobase upgrade` does not remove this marker. Only remove it
    # after the command above has returned successfully.
    rm -f "${STORAGE_ROOT}/.upgrading"
    echo '[runtime] app-main: migration gate complete; starting NocoBase'
    exec yarn start
    ;;
  backup)
    export READINESS_URL
    wait_for_predecessor 0 5
    cd "${APP_ROOT}"
    echo '[runtime] backup: starting NocoBase without quickstart/migration'
    exec yarn start
    ;;
  worker)
    export READINESS_URL
    worker_timeout="${WORKER_READY_TIMEOUT_SECONDS:-900}"
    worker_interval="${WORKER_READY_INTERVAL_SECONDS:-5}"
    worker_grace="${WORKER_READY_GRACE_SECONDS:-15}"
    if ! is_non_negative_integer "${worker_grace}"; then
      echo '[runtime] WORKER_READY_GRACE_SECONDS must be a non-negative integer' >&2
      exit 1
    fi
    if ! wait_for_predecessor "${worker_timeout}" "${worker_interval}"; then
      # Fail closed: Docker/Kubernetes restart policy may retry, but this worker
      # never races app-main's install, upgrade, or migration gate.
      exit 1
    fi
    if [ "${worker_grace}" -gt 0 ]; then
      echo "[runtime] worker: readiness confirmed; waiting ${worker_grace}s grace period"
      sleep "${worker_grace}"
    fi
    cd "${APP_ROOT}"
    echo '[runtime] worker: starting NocoBase without install/upgrade/migration'
    exec yarn start
    ;;
  *)
    echo "[runtime] unsupported APP_NODE_ROLE: ${APP_NODE_ROLE}" >&2
    exit 1
    ;;
esac
