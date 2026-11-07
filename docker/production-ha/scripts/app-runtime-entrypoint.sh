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

assert_guardian_cluster_prerequisites() {
  if [ "${STARTUP_GUARDIAN_CLUSTER_MODE:-}" != 'redis-postgres' ]; then
    echo "[runtime] unsupported Startup Guardian cluster mode: ${STARTUP_GUARDIAN_CLUSTER_MODE}" >&2
    exit 1
  fi

  case "${APP_NODE_ROLE:-}" in
    main|backup) ;;
    *)
      echo '[runtime] Startup Guardian HA only supports enrolled app main/backup nodes' >&2
      exit 1
      ;;
  esac

  if [ "${APP_ROLE:-app}" != 'app' ] || [ "${SKILL_HUB_SANDBOX:-false}" = 'true' ]; then
    echo '[runtime] Startup Guardian HA refuses non-app and sandbox processes' >&2
    exit 1
  fi
  case "${WORKER_MODE:-}" in
    ''|main|app|'!') ;;
    *)
      echo '[runtime] Startup Guardian HA refuses worker-enabled app processes' >&2
      exit 1
      ;;
  esac

  : "${STARTUP_GUARDIAN_APP_ID:?Set STARTUP_GUARDIAN_APP_ID for the enrolled app identity}"
  : "${STARTUP_GUARDIAN_DEPLOYMENT_ID:?Set STARTUP_GUARDIAN_DEPLOYMENT_ID for the enrolled deployment}"
  : "${STARTUP_GUARDIAN_NODE_ID:?Set the stable STARTUP_GUARDIAN_NODE_ID for this app node}"
  : "${STARTUP_GUARDIAN_CLUSTER_MEMBERS:?Set the complete STARTUP_GUARDIAN_CLUSTER_MEMBERS roster}"
  : "${NODE_REGISTRY_REDIS_URL:?Set NODE_REGISTRY_REDIS_URL to the Cluster Manager registry Redis}"
  : "${LOCK_ADAPTER_REDIS_URL:?Set LOCK_ADAPTER_REDIS_URL to the shared recovery lock Redis}"
  if [ "${STARTUP_GUARDIAN_CLUSTER_NO_WORKERS:-false}" != 'true' ]; then
    echo '[runtime] set STARTUP_GUARDIAN_CLUSTER_NO_WORKERS=true only after confirming there are no shared-database workers' >&2
    exit 1
  fi
  if [ "${DB_DIALECT:-}" != 'postgres' ]; then
    echo '[runtime] Startup Guardian HA requires DB_DIALECT=postgres' >&2
    exit 1
  fi
  if [ "${APP_NAME:-main}" != "${STARTUP_GUARDIAN_APP_ID}" ]; then
    echo '[runtime] APP_NAME must match STARTUP_GUARDIAN_APP_ID for the enrolled app identity' >&2
    exit 1
  fi

  node <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
function readPackage(name) {
  const manifest = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8'));
}
function fail(message) {
  process.stderr.write(`[runtime] ${message}\n`);
  process.exit(1);
}
try {
  const server = readPackage('@nocobase/server');
  if (server.version !== '2.2.40') fail(`Startup Guardian HA requires @nocobase/server 2.2.40; found ${server.version || 'unknown'}`);
  const guardian = readPackage('plugin-startup-guardian');
  if (!guardian.bin || typeof guardian.bin['startup-guardian'] !== 'string') {
    fail('Startup Guardian package does not declare its runner bin');
  }
  const guardianBin = path.resolve(root, 'node_modules/plugin-startup-guardian', guardian.bin['startup-guardian']);
  if (!fs.existsSync(guardianBin)) fail('Startup Guardian runner bin is missing; install the complete plugin package first');
  const childBin = path.join(path.dirname(guardianBin), 'nocobase-child.cjs');
  if (!fs.existsSync(childBin)) fail('Startup Guardian child bootstrap is missing; install the complete plugin package first');
  const clusterManager = readPackage('plugin-cluster-manager');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(clusterManager.version || ''));
  const version = match ? match.slice(1).map(Number) : [];
  const isTooOld = version.length !== 3 || version[0] < 1 ||
    (version[0] === 1 && (version[1] < 3 || (version[1] === 3 && version[2] < 5)));
  if (isTooOld) {
    fail(`Startup Guardian HA requires plugin-cluster-manager >=1.3.5; found ${clusterManager.version || 'unknown'}`);
  }
  const recovery = require('plugin-cluster-manager/recovery');
  if (recovery.STARTUP_RECOVERY_LOCK_API_VERSION !== 1) {
    fail('Cluster Manager recovery lock API version 1 is unavailable; install plugin-cluster-manager >=1.3.5');
  }
} catch (error) {
  if (error && typeof error.message === 'string' && error.message.startsWith('[runtime]')) throw error;
  fail('Startup Guardian HA prerequisites are unavailable; verify the installed Guardian, Cluster Manager, and core packages');
}
NODE
}

start_nocobase() {
  if [ -z "${STARTUP_GUARDIAN_CLUSTER_MODE:-}" ]; then
    exec yarn start
  fi
  exec node --preserve-symlinks "${APP_ROOT}/node_modules/plugin-startup-guardian/bin/startup-guardian.cjs" start \
    --app-id "${STARTUP_GUARDIAN_APP_ID}" --deployment-id "${STARTUP_GUARDIAN_DEPLOYMENT_ID}" -- \
    node --preserve-symlinks "${APP_ROOT}/node_modules/plugin-startup-guardian/bin/nocobase-child.cjs"
}

install_git_if_missing
prepare_app_source
cd "${APP_ROOT}"
if [ -n "${STARTUP_GUARDIAN_CLUSTER_MODE:-}" ]; then
  assert_guardian_cluster_prerequisites
fi

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
    start_nocobase
    ;;
  backup)
    export READINESS_URL
    wait_for_predecessor 0 5
    cd "${APP_ROOT}"
    echo '[runtime] backup: starting NocoBase without quickstart/migration'
    start_nocobase
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
