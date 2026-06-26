/// <reference types="node" />

interface ImportMetaHot {
  signalOnDispose: AbortSignal;
}

interface ImportMeta {
  hot?: ImportMetaHot;
}

declare function __oms_import__(moduleId: string): Promise<unknown>;
