/// <reference lib="dom"/>

console.log(`OMS worker entry prelude`);

globalThis.require('editor/preload').init();
globalThis.Editor = globalThis.require('editor');

if (typeof document !== 'undefined') {
  document.title = 'OMS Worker';
}
