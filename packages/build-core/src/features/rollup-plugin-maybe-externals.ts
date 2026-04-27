import type { Plugin } from 'rollup';
import ejs from 'ejs';

const modulePrefixRouter = '\0oms-maybe-externals:router:';
const modulePrefixExternal = '\0oms-maybe-externals:external:';
const modulePrefixActual = '\0oms-maybe-externals:actual:';

export function rollupPluginMaybeExternals({
  maybeExternals,
}: {
  maybeExternals: string[];
}): Plugin {
  const pluginId = 'oms:maybe-externals';

  if (maybeExternals.length === 0) {
    return {
      name: pluginId,
    };
  }

  return {
    name: pluginId,

    async resolveId(id, importer, opts) {
      if (maybeExternals.includes(id)) {
        const resolved = await this.resolve(id, importer, {
          ...opts,
          skipSelf: true,
        });
        if (!resolved || resolved.external) {
          return id;
        }
        return modulePrefixRouter + resolved.id;
      }

      if (id.startsWith(modulePrefixActual)) {
        return id.slice(modulePrefixActual.length);
      }

      if (id.startsWith(modulePrefixExternal)) {
        return id;
      }
    },

    async load(id) {
      if (id.startsWith(modulePrefixRouter)) {
        const m = id.slice(modulePrefixRouter.length);
        const code = ejs.render(routerModuleTemplate, {
          externalModule: modulePrefixExternal + m,
          actualModule: modulePrefixActual + m,
        });
        return {
          code,
          syntheticNamedExports: true,
        };
      }

      if (id.startsWith(modulePrefixExternal)) {
        const m = id.slice(modulePrefixExternal.length);
        const code = ejs.render(externalModuleTemplate, {
          id: m,
        });
        return {
          code,
          syntheticNamedExports: true,
        };
      }
    },
  };
}

const routerModuleTemplate = `
import { EDITOR_NOT_IN_PREVIEW } from 'cc/env';

export default await (() => {
  if (EDITOR_NOT_IN_PREVIEW) {
    return import(<%- JSON.stringify(externalModule) %>);
  } else {
    return import(<%- JSON.stringify(actualModule) %>);
  }
})();
`;

const externalModuleTemplate = `
import { createRequire } from 'node:module';
const requireFromThere = createRequire(import.meta.url);
export default requireFromThere(<%- JSON.stringify(id) %>);
`;
