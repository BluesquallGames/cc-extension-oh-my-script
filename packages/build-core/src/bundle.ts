import { parse } from 'node:path';
import { makeFileSystemAbsoluteImportSpecifier } from './utils/import-specifier.js';

export interface BundleOptions {
  id: string;
  indexModuleDirs: string[];
  indexPreStem: string;
  indexPostStem: string;
}

export class Bundle {
  constructor(options: BundleOptions) {
    this._id = options.id;
    this._indexModuleDirs = options.indexModuleDirs;
    this._desiredIndexModuleFileStemPre = options.indexPreStem;
    this._desiredIndexModuleFileStemPost = options.indexPostStem;
  }

  get empty() {
    return !this._indexPreModule && !this._indexPostModule && this._componentModules.length === 0;
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
    if (this._indexPreModule) {
      implicitEntries.push(this._indexPreModule);
    }
    implicitEntries.push(...this._componentModules);
    if (this._indexPostModule) {
      implicitEntries.push(this._indexPostModule);
    }
    return implicitEntries;
  }

  isIndexModule(path: string) {
    const fileType = this._classifySourceFile(path);
    return fileType === SourceFileType.indexPost || fileType === SourceFileType.indexPre;
  }

  isComponentModule(path: string) {
    return this._classifySourceFile(path) === SourceFileType.component;
  }

  addSourceFile(path: string) {
    let shouldRebuildBundle = false;
    const fileType = this._classifySourceFile(path);
    switch (fileType) {
    case SourceFileType.component: {
      shouldRebuildBundle = this._addComponentModule(path) || shouldRebuildBundle;
      break;
    }
    case SourceFileType.indexPost: {
      if (this._indexPostModule !== path) {
        this._indexPostModule = path;
        this._invalidateEntry();
        shouldRebuildBundle = true;
      }
      break;
    }
    case SourceFileType.indexPre: {
      if (this._indexPreModule !== path) {
        this._indexPreModule = path;
        this._invalidateEntry();
        shouldRebuildBundle = true;
      }
      break;
    }
    default: {
      break;
    }
    }
    return shouldRebuildBundle;
  }

  removeSourceFile(path: string) {
    let shouldRebuildBundle = false;
    const fileType = this._classifySourceFile(path);
    switch (fileType) {
    case SourceFileType.component: {
      shouldRebuildBundle = this._deleteComponentModule(path) || shouldRebuildBundle;
      break;
    }
    case SourceFileType.indexPost: {
      if (this._indexPostModule === path) {
        this._indexPostModule = '';
        this._invalidateEntry();
        shouldRebuildBundle = true;
      }
      break;
    }
    case SourceFileType.indexPre: {
      if (this._indexPreModule === path) {
        this._indexPreModule = '';
        this._invalidateEntry();
        shouldRebuildBundle = true;
      }
      break;
    }
    default: {
      break;
    }
    }
    return shouldRebuildBundle;
  }

  private _indexPreModule = '';
  private _indexPostModule = '';
  private _componentModules: string[] = [];
  private _entryDirty = true;
  private _entrySource = '';
  private _id: string;
  private _indexModuleDirs: string[];
  private _desiredIndexModuleFileStemPre: string;
  private _desiredIndexModuleFileStemPost: string;

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
    if (this._indexPreModule) {
      lines.push(`export * from '${makeFileSystemAbsoluteImportSpecifier(this._indexPreModule)}';`);
    }
    for (const componentModule of this._componentModules) {
      lines.push(`import '${makeFileSystemAbsoluteImportSpecifier(componentModule)}';`);
    }
    if (this._indexPostModule) {
      lines.push(`export * from '${makeFileSystemAbsoluteImportSpecifier(this._indexPostModule)}';`);
    }
    lines.push(
      '',
      'export {};',
    );
    return lines.join('\n');
  }

  private _classifySourceFile(sourceFile: string): SourceFileType {
    if (/\.component(\.editor)?\.[cm]?[jt]s$/.test(sourceFile.toLocaleLowerCase())) {
      return SourceFileType.component;
    }

    const { dir, name, ext } = parse(sourceFile);
    if (this._indexModuleDirs.includes(dir)) {
      if (/^\.[cm]?[jt]s$/.test(ext.toLocaleLowerCase())) {
        if (name.toLocaleLowerCase() === this._desiredIndexModuleFileStemPost) {
          return SourceFileType.indexPost;
        }
        if (name.toLocaleLowerCase() === this._desiredIndexModuleFileStemPre) {
          return SourceFileType.indexPre;
        }
      }
    }

    return SourceFileType.other;
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
}

enum SourceFileType {
  indexPre = 'indexPre',
  indexPost = 'indexPost',
  component = 'component',
  other = 'other',
}
