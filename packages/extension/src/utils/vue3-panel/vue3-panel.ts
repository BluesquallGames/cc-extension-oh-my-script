import * as vue from 'vue';

type PromiseLike<T> = Promise<T> | T;

export interface PanelSetupOptions<TPanelSetupOptions extends unknown[] = never> {
  container: HTMLElement;
  clientWidth: number;
  args: TPanelSetupOptions;
}

export abstract class VuePanel<TPanelSetupOptions extends unknown[] = never> {
  async setup(
    opts: PanelSetupOptions<TPanelSetupOptions>,
  ) {
    if (this._vueApp) {
      this._vueApp.unmount();
      this._vueApp = undefined;
    }

    this._vueApp = await this.onSetup(opts);
  }

  close() {
    if (this._vueApp) {
      this._vueApp.unmount();
      this._vueApp = undefined;
    }
    return this.onClose();
  }

  beforeClose() {
    return this.onBeforeClose();
  }

  protected get appCreated() {
    return !!this._vueApp;
  }

  protected get vueApp(): vue.App {
    if (!this._vueApp) {
      throw new Error('Vue app is not created yet');
    }
    return this._vueApp;
  }

  protected abstract onSetup(opts: PanelSetupOptions<TPanelSetupOptions>): PromiseLike<vue.App>;

  protected onBeforeClose(): PromiseLike<void> {
    // Panels may override this hook to prevent closing.
  }

  protected onClose(): PromiseLike<void> {
    // Panels may override this hook to release their resources.
  }

  private _vueApp: vue.App | undefined = undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VuePanelListenerCallback = (...args: any[]) => PromiseLike<void>;

export type VuePanelListener = VuePanelListenerCallback | {
  callback: VuePanelListenerCallback;
  ignoreIfPanelNotReady?: boolean;
};

export interface VuePanelClassRequirements {
  readonly style: string;

  readonly containerStyle?: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly exposedMethods?: Record<string, (...args: any[]) => PromiseLike<void>>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly exposedListeners?: Record<string, (...args: any[]) => PromiseLike<void>>;
}

const containerStyle = `
.vue3-panel-container {
  width: 100%;
  height: 100%;
}
`;

export interface DefinedVuePanelThis {
  $: {
    container: HTMLElement;
  };
  vuePanel: VuePanel | undefined;
  clientWidth: number;
}

export function defineVuePanel<TVuePanel extends VuePanel, TVuePanelType extends (new (
  ...args: never[]) => TVuePanel) & VuePanelClassRequirements>(panelClass: TVuePanelType) {
  let vuePanel: TVuePanel | undefined = undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapMethod = (f: (this: TVuePanel, ...args: any[]) => PromiseLike<void>,
    methodKey: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (this: DefinedVuePanelThis, ...args: any[]) {
      const vuePanel = this.vuePanel;
      if (!vuePanel) {
        throw new Error(`Error calling ${methodKey}: Vue panel is not created yet`);
      }
      return f.call(vuePanel as TVuePanel, ...args);
    };
  };

  const wrapListener = (f: VuePanelListener, listenerKey: string) => {
    if (typeof f === 'function') {
      return wrapMethod(f, listenerKey);
    }
    if (f.ignoreIfPanelNotReady) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return function (this: DefinedVuePanelThis, ...args: any[]) {
        const vuePanel = this.vuePanel;
        if (!vuePanel) {
          return;
        }
        return f.callback.call(vuePanel as TVuePanel, ...args);
      };
    } else {
      return wrapMethod(f.callback, listenerKey);
    }
  };

  return {
    template: `<div class="vue3-panel-container"></div>`,

    $: { container: '.vue3-panel-container' },

    style: containerStyle + '\n' + (panelClass.containerStyle ?? '') + '\n' + panelClass.style,

    methods: panelClass.exposedMethods
      ? Object.fromEntries(Object.entries(panelClass
        .exposedMethods).map(([key, value]) => [key, wrapMethod(value, key)]))
      : {},

    listeners: panelClass.exposedListeners
      ? Object.fromEntries(Object.entries(panelClass
        .exposedListeners).map(([key, value]) => [key, wrapListener(value, key)]))
      : {},

    async ready(this: DefinedVuePanelThis, ...args: ConstructorParameters<TVuePanelType>) {
      vuePanel = new panelClass(...args);
      await vuePanel.setup({
        container: this.$.container,
        // @ts-expect-error Creator panel setup and constructor arguments differ.
        args,
        clientWidth: this.clientWidth,
      });
      this.vuePanel = vuePanel;
    },

    async beforeClose() {
      if (vuePanel) {
        await vuePanel.beforeClose();
      }
    },

    async close() {
      if (vuePanel) {
        await vuePanel.close();
        vuePanel = undefined;
      }
    },
  };
}
