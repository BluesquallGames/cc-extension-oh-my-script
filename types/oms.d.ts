/// <reference types="node" />

interface ImportMetaHot {
  signalOnDispose: AbortSignal;
}

interface ImportMeta {
  hot?: ImportMetaHot;
}

declare module 'module' {
  global {
    interface ImportMeta {
      hot?: ImportMetaHot;
    }
  }
}
