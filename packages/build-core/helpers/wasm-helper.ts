import { EDITOR, HTML5, NODEJS } from 'cc/env';

export async function importWasmBinary(input: string) {
  if (EDITOR || NODEJS) {
    const { createRequire } = await import('node:module');
    const r = createRequire(typeof __dirname === 'string' ? __dirname : import.meta.url);
    const _ps = r('path');
    const fs = r('fs/promises');
    const { fileURLToPath } = r('url');
    const binary = await fs.readFile(fileURLToPath(input));
    return binary;
  } else if (HTML5) {
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to fetch wasm file: ${input}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } else {
    throw new Error(`Unknown platform to import WebAssembly binary: ${input}`);
  }
}

export async function importWasmInstance(input: string, imports?: WebAssembly.Imports) {
  if (EDITOR || NODEJS) {
    const r = require;
    const _ps = r('path');
    const fs = r('fs/promises');
    const { fileURLToPath } = r('url');
    const binary = await fs.readFile(fileURLToPath(input));
    const module = await WebAssembly.compile(binary);
    return await WebAssembly.instantiate(module, imports);
  } else if (HTML5 || NODEJS) {
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to fetch WebAssembly file: ${input}`);
    }
    return (await WebAssembly.instantiateStreaming(response, imports)).instance;
  } else {
    throw new Error(`Unknown platform to import WebAssembly instance: ${input}`);
  }
}
