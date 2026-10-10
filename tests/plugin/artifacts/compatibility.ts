import type { Plugin as VitePlugin } from 'vite';
import type { OmsPlugin } from '@oms/plugin';

/// @expect Every plugin authored against the OMS subset is a valid Vite plugin.
declare const plugin: OmsPlugin;
export const vitePlugin: VitePlugin = plugin;
type UnsupportedKeys = Exclude<keyof OmsPlugin, keyof VitePlugin>;
declare const noExtraKeys: UnsupportedKeys;
export const absent: never = noExtraKeys;
