import { SceneModuleSystem } from './module-system.js';

export class SceneScriptManager {
  constructor() {
    this._moduleSystem = new SceneModuleSystem();
  }

  async reload() {
    await this._moduleSystem.reload();
  }

  async import(moduleId: string) {
    return this._moduleSystem.import(moduleId);
  }

  private _moduleSystem: SceneModuleSystem;
}
