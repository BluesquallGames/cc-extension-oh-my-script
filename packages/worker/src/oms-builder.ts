import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as vite from 'vite';
import fs from 'fs-extra';
import { logger } from './logger.js';

export class OmsBuilder {
  constructor({
    project,
  }: {
    project: string;
  }) {
    this._projectPath = project;
  }

  async rebuild() {
    await this._rebuild();
  }

  private _projectPath: string;
  private _viteBuilder: vite.ViteBuilder | undefined;

  private async _clean() {
    this._viteBuilder = undefined;
  }

  private async _rebuild() {
    await this._clean();
    const sourceRoot = join(this._projectPath, 'src');
    const entries = [...this._listEntries(sourceRoot)];
    if (entries.length === 0) {
      logger.debug('No entry found, skip rebuild');
      return;
    }
    const viteConfig = await this._makeViteConfig(sourceRoot, entries);
    const viteBuilder = await vite.createBuilder(viteConfig);
    this._viteBuilder = viteBuilder;
    await viteBuilder.buildApp();
  }

  private async _makeViteConfig(sourceRoot: string, entries: string[]): Promise<vite.InlineConfig> {
    const outDir = resolve(this._projectPath, 'temp', 'oms', 'out');
    const shadowDir = resolve(this._projectPath, 'assets/shadow-source');
    return {
      root: this._projectPath,
      build: {
        outDir,
        minify: false,
        sourcemap: true,
        lib: {
          entry: entries,
          formats: ['es'],
        },
      },
      plugins: [
        {
          name: 'oms-builder',
          async writeBundle(options, bundle) {
            for (const [name, chunk] of Object.entries(bundle)) {
              if (chunk.type === 'chunk') {
                if (chunk.isEntry && !chunk.isImplicitEntry) {
                  if (!chunk.facadeModuleId) {
                    continue;
                  }
                  const relativePath = relative(sourceRoot, chunk.facadeModuleId);
                  if (isAbsolute(relativePath) || relativePath.startsWith('..')) {
                    this.warn(`Entry bundle ${name} is not under source root ${sourceRoot}, skip it`);
                  } else {
                    const shadowPath = resolve(shadowDir, relativePath);
                    fs.ensureDirSync(dirname(shadowPath));
                    const chunkFinalPath = resolve(outDir, chunk.fileName);
                    const specifierToChunk = makeImportSpecifier(dirname(shadowPath), chunkFinalPath);
                    await fs.writeFile(shadowPath, `
                    /// This is shadow file generated from ${chunk.fileName}
                    export * from '${specifierToChunk}';
                    `, 'utf8');
                  }
                }
              }
            }
          },
        },
      ],
    };
  }

  private *_listEntries(sourceRoot: string) {
    if (!fs.existsSync(sourceRoot)) {
      return;
    }
    for (const entry of readDirRecurse(sourceRoot)) {
      yield join(sourceRoot, entry);
    }
  }
}

function* readDirRecurse(root: string, current: string = ''): Generator<string> {
  const path = resolve(root, current);
  const stat = fs.statSync(path);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(path)) {
      yield * readDirRecurse(root, join(current, entry));
    }
  } else {
    yield current;
  }
}

function makeImportSpecifier(from: string, to: string) {
  let path = relative(from, to).replace(/\\/g, '/');
  if (path.startsWith('./')) {
    path = './' + path;
  }
  return path;
}
