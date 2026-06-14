import { isAbsolute, resolve } from 'node:path';
import fs from 'fs-extra';
import { parse } from 'dotenv';
import { expand } from 'dotenv-expand';
import type { OmsProjectConfig } from './config.js';

export interface ProjectDefineResult {
  define: Record<string, string>;
  watchFiles: string[];
}

export async function createProjectDefine(options: {
  config: OmsProjectConfig;
  projectRoot: string | undefined;
  mode?: string;
}): Promise<ProjectDefineResult> {
  const { config, projectRoot } = options;
  const mode = options.mode ?? config.mode;
  if (mode === 'local') {
    throw new Error('"local" cannot be used as OMS mode because .local env files are reserved.');
  }

  const { env, files } = await loadProjectEnv({
    projectRoot,
    envDir: config.envDir,
    mode,
    prefixes: config.envPrefix,
  });

  const importMetaEnvDefine: Record<string, string> = {
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env.DEV': String(mode !== 'production'),
    'import.meta.env.PROD': String(mode === 'production'),
    'import.meta.env.SSR': 'false',
  };
  for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    importMetaEnvDefine[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  const define = {
    ...importMetaEnvDefine,
    ...config.define,
  };
  if (!Object.hasOwn(define, 'import.meta.env')) {
    define['import.meta.env'] = serializeImportMetaEnv(define);
  }
  if (!Object.hasOwn(define, 'import.meta.env.*')) {
    define['import.meta.env.*'] = 'undefined';
  }

  return {
    define,
    watchFiles: files,
  };
}

async function loadProjectEnv(options: {
  projectRoot: string | undefined;
  envDir: string | undefined;
  mode: string;
  prefixes: string[];
}) {
  const files = options.projectRoot
    ? getProjectEnvFiles(options.projectRoot, options.envDir, options.mode)
    : [];
  const parsed: Record<string, string> = {};
  for (const file of files) {
    if (!(await fs.pathExists(file))) {
      continue;
    }
    Object.assign(parsed, parse(await fs.readFile(file, 'utf8')));
  }

  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      processEnv[key] = value;
    }
  }
  const expanded = expand({
    parsed,
    processEnv,
  }).parsed ?? parsed;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(expanded)) {
    if (matchesEnvPrefix(key, options.prefixes)) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (matchesEnvPrefix(key, options.prefixes)) {
      env[key] = value;
    }
  }

  return {
    env,
    files,
  };
}

function getProjectEnvFiles(projectRoot: string, envDir: string | undefined, mode: string) {
  const root = envDir
    ? isAbsolute(envDir) ? envDir : resolve(projectRoot, envDir)
    : projectRoot;
  return [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`,
  ].map((file) => resolve(root, file));
}

function matchesEnvPrefix(key: string, prefixes: string[]) {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function serializeImportMetaEnv(define: Record<string, string>) {
  const entries = Object.entries(define)
    .filter(([key]) => key.startsWith('import.meta.env.') && key !== 'import.meta.env.*')
    .map(([key, value]) => [key.slice('import.meta.env.'.length), value] as const)
    .filter(([key]) => key.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return `({ ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(', ')} })`;
}
