#!/bin/sh

set -eu

APP_ROOT='/app/nocobase'
STORAGE_ROOT="${APP_ROOT}/storage"
READINESS_URL="${APP_START_AFTER_URL:-http://app-main:${APP_PORT:-13000}/api/app:getInfo}"

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

wait_for_predecessor() {
  echo "[runtime] waiting for predecessor readiness at ${READINESS_URL}"
  attempt=0
  while ! predecessor_is_ready; do
    attempt=$((attempt + 1))
    if [ $((attempt % 12)) -eq 0 ]; then
      echo "[runtime] predecessor is not ready yet (attempt ${attempt})"
    fi
    sleep 5
  done
  echo '[runtime] predecessor is ready'
}

install_git_if_missing
prepare_app_source

case "${APP_NODE_ROLE:-backup}" in
  main)
    cd "${APP_ROOT}"
    echo '[runtime] app-main: verifying installation'
    yarn nocobase install

    if [ -e "${STORAGE_ROOT}/.upgrading" ]; then
      echo '[runtime] app-main: pending upgrade marker found; running full upgrade'
      yarn nocobase upgrade
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
    wait_for_predecessor
    cd "${APP_ROOT}"
    echo '[runtime] backup: starting NocoBase without quickstart/migration'
    exec yarn start
    ;;
  *)
    echo "[runtime] unsupported APP_NODE_ROLE: ${APP_NODE_ROLE}" >&2
    exit 1
    ;;
esac
