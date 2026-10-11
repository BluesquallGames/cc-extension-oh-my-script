import { App, createApp, h, Reactive, reactive, VNode } from 'vue';

export function createReactiveVueApp<TComponent extends object, TProps extends object>(
  rootComponent: new () => TComponent,
  data: TProps,
  container: HTMLElement,
): {
  app: App;
  data: Reactive<TProps>;
  exposedMethods: InstanceType<typeof rootComponent>;
} {
  const appData = reactive(data);

  let vNode: VNode = undefined!;
  const app = createApp({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: () => vNode = h(rootComponent, appData as any),
  });
  app.mount(container);

  const exposedMethods = vNode.component!.exposed as InstanceType<typeof rootComponent>;

  return {
    app,
    data: appData,
    exposedMethods,
  };
}
