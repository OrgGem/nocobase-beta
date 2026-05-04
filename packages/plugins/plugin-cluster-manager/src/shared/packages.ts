export const DEFAULT_WORKER_PACKAGES = {
  apt: ['python3', 'python3-pip', 'python3-venv'],
  python: [
    'python-docx',
    'openpyxl',
    'pandas',
    'matplotlib',
    'Pillow',
    'reportlab',
    'jinja2',
    'pyyaml',
    'tabulate',
    'xlsxwriter',
  ],
  npm: ['xlsx', 'docx', 'pdfkit', 'csv-parse', 'archiver', 'sharp', 'lodash', 'dayjs'],
};

export interface WorkerPackageMap {
  apt?: string[];
  npm?: string[];
  python?: string[];
}

export interface CustomPackageMap {
  python?: string[];
  node?: string[];
  npm?: string[];
}

export function normalizePackages(packages?: Array<string | undefined>): string[] {
  if (!Array.isArray(packages)) return [];
  return Array.from(new Set(packages.filter((pkg) => typeof pkg === 'string').map((pkg) => pkg.trim()).filter(Boolean)));
}

export function parsePackageText(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) return normalizePackages(value);
  if (typeof value !== 'string') return normalizePackages(fallback);
  const parsed = value
    .split(/[\n,]/)
    .map((pkg) => pkg.trim())
    .filter(Boolean);
  return normalizePackages(parsed);
}

export function formatPackageText(packages?: string[]): string {
  return normalizePackages(packages).join('\n');
}

export function packagesFromConfig(config: {
  aptPackages?: unknown;
  pythonPackages?: unknown;
  npmPackages?: unknown;
}): WorkerPackageMap {
  return {
    apt: parsePackageText(config.aptPackages, DEFAULT_WORKER_PACKAGES.apt),
    python: parsePackageText(config.pythonPackages, DEFAULT_WORKER_PACKAGES.python),
    npm: parsePackageText(config.npmPackages, DEFAULT_WORKER_PACKAGES.npm),
  };
}
