import { SceneModuleSystem } from './module-system.js';

export interface SceneScriptManagerOptions {
  globalImport?: boolean;
}

export class SceneScriptManager {
  constructor(options: SceneScriptManagerOptions = {}) {
    this._moduleSystem = new SceneModuleSystem({
      globalImport: options.globalImport,
    });
  }

  async reload() {
    await this._moduleSystem.reload();
  }

  async import(moduleId: string) {
    return this._moduleSystem.import(moduleId);
  }

  private _moduleSystem: SceneModuleSystem;
}
