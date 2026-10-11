/// <reference lib="dom"/>

console.log(`OMS worker entry prelude`);

// Creator supplies these modules in its worker host rather than node_modules.
// eslint-disable-next-line n/no-missing-require
globalThis.require('editor/preload').init();
// eslint-disable-next-line n/no-missing-require
globalThis.Editor = globalThis.require('editor');

if (typeof document !== 'undefined') {
  document.title = 'OMS Worker';
}
