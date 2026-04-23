import Ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpersDir } from '../helpers-dir.js';

export interface CCEnvParams {
  platform?: string;
  mode?: string;
  headless?: boolean;
  debug?: boolean;
}

export function generateCCEnvModuleSource(input: {
  params: CCEnvParams;
}) {
  const template = readFileSync(join(helpersDir, 'cc-env.ts.ejs'), 'utf-8');
  return Ejs.render(template, {
    params: input.params,
  });
}
