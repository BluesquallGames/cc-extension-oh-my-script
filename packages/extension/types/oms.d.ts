/// <reference types="node" />

declare module '*?uuid' {
  const uuid: string;
  export default uuid;
}

interface OmsConfigContext {
  mode: string;
}

interface ImportMetaHot {
  signalOnDispose: AbortSignal;
}

interface ImportMeta {
  hot?: ImportMetaHot;
}

declare function __oms_import__(moduleId: string): Promise<unknown>;
