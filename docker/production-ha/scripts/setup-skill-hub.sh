#!/bin/sh
# ===========================================================================
# Skill Hub — Worker Sandbox Environment Setup
# ===========================================================================
# This script installs Python 3 + pip and necessary libraries on the worker
# container for Skill Hub sandbox execution.
#
# Usage Options:
#   1. Place in storage/scripts/ — auto-executed by worker at startup
#   2. Mount via docker-compose volume — runs on every worker restart
#   3. docker exec <container> sh /path/to/setup-skill-hub.sh
#
# Note: Packages are installed at runtime, so no image rebuild is needed.
#       Use pip/npm cache volumes for faster restarts.
# ===========================================================================

set -e

echo "======================================================"
echo "  Skill Hub: Setting up sandbox environment"
echo "======================================================"

# ── 1. Install Python 3 + pip ──────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  echo "[skill-hub] Installing Python 3 + pip..."
  apt-get update -qq && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*
else
  echo "[skill-hub] Python 3 already installed: $(python3 --version)"
fi

# ── 2. Install Python libraries ────────────────────────────────────────────
echo "[skill-hub] Installing Python packages..."
pip3 install --no-cache-dir --break-system-packages \
  python-docx \
  openpyxl \
  pandas \
  matplotlib \
  Pillow \
  reportlab \
  jinja2 \
  pyyaml \
  tabulate \
  xlsxwriter \
|| echo "[skill-hub] Warning: Some Python packages may have failed"

# ── 3. Install Node.js global packages ─────────────────────────────────────
echo "[skill-hub] Installing Node.js packages..."
npm install -g --silent \
  xlsx \
  docx \
  pdfkit \
  csv-parse \
  archiver \
  sharp \
  lodash \
  dayjs \
|| echo "[skill-hub] Warning: Some Node packages may have failed"

# ── 4. Create sandbox workspace ────────────────────────────────────────────
mkdir -p /app/sandbox-workspace 2>/dev/null || true

# ── 5. Verify ──────────────────────────────────────────────────────────────
echo ""
echo "[skill-hub] === Verification ==="
python3 --version 2>/dev/null || echo "[skill-hub] Python3 NOT found"
python3 -c "import docx, openpyxl, pandas; print('[skill-hub] Core Python packages: OK')" 2>/dev/null \
  || echo "[skill-hub] Warning: Python package verification failed"
node -e "try{require('xlsx');require('dayjs');console.log('[skill-hub] Core Node packages: OK')}catch(e){console.log('[skill-hub] Warning: '+e.message)}" 2>/dev/null \
  || echo "[skill-hub] Warning: Node package verification failed"

echo ""
echo "======================================================"
echo "  Skill Hub: Setup complete"
echo "======================================================"
