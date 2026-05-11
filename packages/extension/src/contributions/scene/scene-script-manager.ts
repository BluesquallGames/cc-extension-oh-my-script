import { SceneModuleSystem } from './module-system.js';

export class SceneScriptManager {
  constructor() {
    this._moduleSystem = new SceneModuleSystem();
  }

  async reload() {
    await this._moduleSystem.reload();
  }

  private _moduleSystem: SceneModuleSystem;
}
