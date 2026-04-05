/// <reference types="node" />

interface ImportMetaHot {
  signalOnDispose: AbortSignal;
}

interface ImportMeta {
  hot?: ImportMetaHot;
}
