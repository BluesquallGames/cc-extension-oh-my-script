import type { OmsPlugin } from '@oms/plugin';

declare const plugin: OmsPlugin;
void plugin;
/// @expect The plugin package does not augment ImportMeta.
// @ts-expect-error
import.meta.hot;
/// @expect only documented package entry points are consumable.
// @ts-expect-error
import type { OmsPluginContext } from '@oms/plugin/index';
/// @expect dependencies/internal implementation types are not public package entry points.
// @ts-expect-error
import type { Domain } from '@oms/plugin/internal/domain';

/// @expect Removed dev/HMR entry points cannot be consumed.
// @ts-expect-error
import type {} from '@oms/plugin/experimental/dev';
// @ts-expect-error
import type {} from '@oms/plugin/experimental/hmr';
// @ts-expect-error
import type {} from '@oms/plugin/experimental/client';

/// @expect Unused helpers and hook-specific views are no longer exported.
// @ts-expect-error
import { definePlugin } from '@oms/plugin';
// @ts-expect-error
import type { OmsTransformContext, OmsPluginConfig, OmsResolvedConfig, OmsConfigEnvironment, OmsDomainUserConfig } from '@oms/plugin';
