import { parse } from 'node:path';
import { extractInlineUUID, UUIDManager } from './uuid-manager.js';
import { logger } from './logger.js';
import fs from 'fs-extra';
import { makeFileSystemAbsoluteImportSpecifier } from './utils/import-specifier.js';
import dedent from 'dedent';

export class Bundle {
  constructor(private _id: string, private _indexModuleDirs: string[], private _uuidManager: UUIDManager) {
  }

  get empty() {
    return !this._indexModule && this._componentModules.length === 0;
  }

  get id() {
    return this._id;
  }

  get entrySource() {
    if (this._entryDirty) {
      this._entrySource = this._makeEntrySource();
      this._entryDirty = false;
    }
    return this._entrySource;
  }

  getImplicitEntries(): string[] {
    const implicitEntries: string[] = [];
    if (this._indexModule) {
      implicitEntries.push(this._indexModule);
    }
    implicitEntries.push(...this._componentModules);
    return implicitEntries;
  }

  entryFiles() {
    const files: string[] = [];
    if (this._indexModule) {
      files.push(this._indexModule);
    }
    files.push(...this._componentModules);
    return files;
  }

  async addSourceFile(path: string) {
    let shouldRebuildBundle = false;
    if (this._isComponentModule(path)) {
      try {
        await this._ensureUUID(path);
      } catch (err) {
        logger.error(`Failed to assign UUID for ${path}: %o`, err);
      }
      shouldRebuildBundle = this._addComponentModule(path) || shouldRebuildBundle;
    } else if (this._isIndexModule(path)) {
      shouldRebuildBundle = this._addIndexModule(path) || shouldRebuildBundle;
    }
    return shouldRebuildBundle;
  }

  removeSourceFile(path: string) {
    let shouldRebuildBundle = false;
    if (this._isComponentModule(path)) {
      this._uuidManager.delete(path);
      shouldRebuildBundle = this._deleteComponentModule(path) || shouldRebuildBundle;
    } else if (this._isIndexModule(path)) {
      shouldRebuildBundle = this._deleteIndexModule(path) || shouldRebuildBundle;
    }
    return shouldRebuildBundle;
  }

  async updateSourceFile(path: string) {
    if (this._isIndexModule(path)) {
      try {
        await this._ensureUUID(path);
      } catch (err) {
        logger.error(`Failed to assign UUID for ${path}: %o`, err);
      }
    }
  }

  private _indexModule = '';
  private _componentModules: string[] = [];
  private _entryDirty = true;
  private _entrySource = '';

  private _invalidateEntry() {
    this._entryDirty = true;
    this._entrySource = '';
  }

  private _makeEntrySource() {
    const lines: string[] = [];
    // lines.push(`const errors = new Set();`);
    // const entryModules: string[] = [];
    // if (this._indexModule) {
    //   entryModules.push(this._indexModule);
    // }
    // for (const componentModule of this._componentModules) {
    //   entryModules.push(componentModule);
    // }
    // lines.push(`for (const exec of [`);
    // for (const entryModule of entryModules) {
    //   lines.push(`  () => import('${makeFileSystemAbsoluteImportSpecifier(entryModule)}'),`);
    // }
    // lines.push(dedent`
    // ]) {
    //   try {
    //     await exec();
    //   } catch (err) {
    //     if (errors.has(err)) {
    //       continue;
    //     }
    //     errors.add(err);
    //     console.error('Failed to import %s: %o', entryModule, err);
    //   }
    // }
    
    // export {};
    // `);
    if (this._indexModule) {
      lines.push(`import '${makeFileSystemAbsoluteImportSpecifier(this._indexModule)}';`);
    }
    for (const componentModule of this._componentModules) {
      lines.push(`import '${makeFileSystemAbsoluteImportSpecifier(componentModule)}';`);
    }
    lines.push(
      '',
      'export {};'
    );
    return lines.join('\n');
  }

  private _isComponentModule(sourceFile: string) {
    return /\.component\.[cm]?[jt]s$/.test(sourceFile.toLocaleLowerCase());
  }

  private _isIndexModule(sourceFile: string) {
    const { dir, name, ext } = parse(sourceFile);
    if (this._indexModuleDirs.includes(dir)
      && /^\.[cm]?[jt]s$/.test(ext.toLowerCase())
      && name.toLocaleLowerCase() === 'index'
    ) {
      return true;
    }
    return false;
  }

    _addComponentModule(sourceFile: string) {
    if (this._componentModules.includes(sourceFile)) {
      return false;
    }
    this._componentModules.push(sourceFile);
    this._invalidateEntry();
    return true;
  }

  private _deleteComponentModule(sourceFile: string) {
    const componentModuleIndex = this._componentModules.findIndex((m) => m === sourceFile);
    if (componentModuleIndex < 0) {
      return false;
    }
    this._componentModules.splice(componentModuleIndex, 1);
    this._invalidateEntry();
    return true;
  }

  private _addIndexModule(sourceFile: string) {
    if (this._indexModule === sourceFile) {
      return false;
    }
    this._indexModule = sourceFile;
    this._invalidateEntry();
    return true;
  }

  private _deleteIndexModule(sourceFile: string) {
    if (this._indexModule !== sourceFile) {
      return false;
    }
    this._indexModule = '';
    this._invalidateEntry();
    return true;
  }

  private async _ensureUUID(sourceFile: string) {
    const code = await fs.readFile(sourceFile, 'utf8');
    const inlineUUID = extractInlineUUID(code) ?? '';
    await this._uuidManager.update(sourceFile, inlineUUID);
  }
}
