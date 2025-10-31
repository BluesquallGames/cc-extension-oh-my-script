import fs from 'fs-extra';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { relative, resolve } from 'node:path';

export class UUIDManager {
  constructor(private _projectPath: string) {

  }

  async loadCentralized(path: string) {
    let centralized: Record<string, string> = {};
    try {
      const content = await fs.readFile(path, 'utf8');
      centralized = JSON.parse(content);
    } catch (err) {
      logger.debug(`Failed to load centralized uuids from ${path}: %o`, err);
      return;
    }
    for (const [k, v] of Object.entries(centralized)) {
      const path = resolve(this._projectPath, k);
      const key = await this._getPathKey(path);
      this._map[key] = {
        uuid: v,
        centralized: true,
      };
    }
  }

  async saveCentralized(path: string) {
    const data = Object.fromEntries(Object.entries(this._map)
      .filter(([_, v]) => {
        return v.centralized;
      })
      .map(([k, v]) => {
        return [
          relative(this._projectPath, k).replace(/\\/g, '/'),
          v.uuid,
        ];
      })
      .sort(([a], [b]) => {
        return a.localeCompare(b);
      }),
    );
    try {
      await fs.outputJSON(path, data, {
        spaces: 2,
      });
    } catch (err) {
      logger.error(`Failed to save centralized uuids to ${path}: %o`, err);
    }
  }

  get(module: string): string | undefined {
    return this._map[module]?.uuid;
  }

  *centralizedModules(): Generator<[string, string]> {
    for (const [k, v] of Object.entries(this._map)) {
      if (v.centralized) {
        yield [k, v.uuid];
      }
    }
  }

  delete(module: string) {
    return delete this._map[module];
  }

  async update(module: string, inlineUUID: string) {
    const pathKey = await this._getPathKey(module);
    let record = this._map[pathKey];
    if (!record) {
      record = {
        uuid: '',
        centralized: true,
      };
      this._map[pathKey] = record;
    }
    if (!inlineUUID) {
      if (record.centralized) {
        if (!record.uuid) {
          record.uuid = this._generateUUID();
        }
      } else {
        record.centralized = true;
        record.uuid = this._generateUUID();
      }
    } else {
      record.centralized = false;
      record.uuid = inlineUUID;
    }
  }

  getDuplications() {
    const map: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(this._map)) {
      const uuid = v.uuid;
      (map[uuid] ??= []).push(k);
    }
    return Object.entries(map)
      .filter(([_, v]) => {
        return v.length > 1;
      });
  }

  private _map: Record<string, {
    uuid: string;
    centralized: boolean;
  }> = {};

  private _generateUUID() {
    return randomUUID();
  }

  private async _getPathKey(path: string) {
    let real = path;
    try {
      real = await fs.realpath(path);
    } catch (err) {
      logger.debug(`Failed to resolve real path of ${path}: %o, may be a broken symlink?`, err);
    }
    return real;
  }
}

function isValidUUID(input: string) {
  // https://stackoverflow.com/a/38191078/10602525
  // return /^[0-9A-F]{8}-[0-9A-F]{4}-[4][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(input);
  return true;
}

function extractUUIDInternal(code: string) {
  const regex = /^\s*\/\/\/\s*<meta\s*"uuid"\s*=\s*"(.*)"\s*\/\s*>\s*/;
  const lines = code.split('\n');
  for (const [lineIndex, line] of lines.entries()) {
    const match = regex.exec(line);
    if (!match) {
      continue;
    }
    const uuid = match[1];
    if (!isValidUUID(uuid)) {
      throw new Error(`Inline uuid annotation: '${uuid}', but it's not an invalid UUID`);
    }
    return {
      lines,
      uuidLine: lineIndex,
      uuid,
    };
  }
  return undefined;
}

export function extractInlineUUID(code: string) {
  return extractUUIDInternal(code)?.uuid;
}

export function writeInlineUUID(code: string, uuid: string): string {
  const uuidLine = `/// <meta "uuid"="${uuid}"/>`;
  const info = extractUUIDInternal(code);
  if (!info) {
    let out = '';
    out += uuidLine;
    out += '\n';
    if (code && !code.startsWith('\n')) {
      out += '\n';
    }
    out += code;
    return out;
  } else {
    const lines = info.lines;
    lines.splice(info.uuidLine, 1, uuidLine);
    return lines.join('\n');
  }
}
