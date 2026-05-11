import { Reactive } from 'vue';
import { createReactiveVueApp } from '../../utils/vue3-panel/index.js';
import { defineVuePanel, PanelSetupOptions, VuePanel } from '../../utils/vue3-panel/vue3-panel.js';
import Right from './right.vue';
import { readFileSync } from 'fs-extra';
import { join } from 'node:path';
import { BuildStateType, RightPanelState } from './state.js';
import { addInnerPackageMessageListener, InnerPackageMessageArgs, InnerPackageMessageId } from '../../inner-package-messaging.js';
// @ts-expect-error
import styleLocation from '@/style-location';

export default defineVuePanel(class RightPanel extends VuePanel<[]> {
  static readonly style = readFileSync(styleLocation, 'utf-8');

  static readonly exposedMethods = {};

  static readonly exposedListeners = {};

  constructor() {
    super();
  }

  protected onSetup(opts: PanelSetupOptions<[]>) {
    const {
      app,
      data,
      exposedMethods,
    } = createReactiveVueApp(
      Right,
      {
        state: {
          state: BuildStateType.never,
        } satisfies RightPanelState,
      },
      opts.container,
    );
    this._appData = data;
    this._rootComponentExposes = exposedMethods;
    this._closeController = new AbortController();
    addInnerPackageMessageListener(InnerPackageMessageId.buildStart, this._onBuildStart.bind(this), { signal: this._closeController.signal });
    addInnerPackageMessageListener(InnerPackageMessageId.buildEnd, this._onBuildEnd.bind(this), { signal: this._closeController.signal });
    return app;
  }

  protected onClose(): void | Promise<void> {
    this._closeController.abort();
  }

  private _appData: Reactive<{
    state: RightPanelState;
  }> = undefined!;

  private _rootComponentExposes: InstanceType<typeof Right> = undefined!;

  private _closeController = new AbortController();

  private _onBuildStart(state: InnerPackageMessageArgs<InnerPackageMessageId.buildStart>[0]) {
    this._appData.state = {
      state: BuildStateType.building,
    };
  }

  private _onBuildEnd(state: InnerPackageMessageArgs<InnerPackageMessageId.buildEnd>[0]) {
    this._appData.state = {
      state: BuildStateType.completed,
      startTime: state.startState.time,
    };
  }
});
