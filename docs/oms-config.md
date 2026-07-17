# OMS 配置

OMS 使用两类配置文件：

- 项目根目录的 `oms.config.*` 配置整个项目构建。
- 扩展根目录的 `oms.config.*` 配置该扩展 domain。

支持的文件名是 `oms.config.js`、`oms.config.cjs` 和 `oms.config.mjs`。配置模块需要 `export default` 一个对象，也可以 `export default` 一个返回对象的函数。

## 项目配置

项目配置用于影响整体构建解析，以及 default/headless profile 的组件扫描与输出。

```js
export default {
  resolve: {
    alias: {
      '@game': './src',
    },
    projectPeers: ['@scope/shared-runtime'],
  },
  profiles: {
    default: {
      exclude: ['src/authority/**'],
    },
    headless: {
      include: ['src/shared/**', 'src/authority/**'],
      build: {
        target: 'node18',
      },
    },
  },
};
```

### resolve.alias

`resolve.alias` 用来配置导入别名。适合给项目源码、共享目录或本地包起一个稳定名字。

### resolve.projectPeers

`projectPeers` 声明哪些包可以通过 `#oms-peer:` 从项目根目录解析。它适合项目和扩展都依赖同一个运行库，并且最终版本应该由项目统一决定的情况。

```js
export default {
  resolve: {
    projectPeers: ['shared-runtime', '@scope/ui-kit'],
  },
};
```

扩展或扩展依赖包里可以显式 import：

```ts
import { something } from '#oms-peer:shared-runtime';
import { Button } from '#oms-peer:@scope/ui-kit/button';
```

OMS 会去掉 `#oms-peer:` 前缀，并从项目根目录解析真实包名。`#oms-peer:` 是显式声明：项目必须安装并允许这个包；如果项目根目录解析不到，构建会报错。

每个条目必须是 bare package name，例如 `react` 或 `@scope/pkg`，不能写相对路径、绝对路径或子路径。`react` 会自动允许 `#oms-peer:react/jsx-runtime` 这类子路径 import。

### profiles

`profiles.default` 与 `profiles.headless` 分别描述两个独立的组件扫描视图。`profiles.headless` 存在时，OMS 会额外生成 headless ESM 输出；不存在时不启用 headless。

```js
export default {
  profiles: {
    default: {
      exclude: ['src/authority/**'],
    },
    headless: {
      include: ['src/shared/**', 'src/authority/**'],
    },
  },
};
```

`profiles.default` 暂时只支持 `exclude`。`profiles.headless` 支持 `include`、`exclude` 和 `build.target`。过滤规则只影响 `.component.*` 自动收集；各自的 `index*` 入口以及入口显式导入的依赖不受影响。同一个组件可以同时进入两个 profile。

## 扩展配置

扩展配置描述扩展自己的源码分区和公开导出。

```js
export default {
  partitions: [
    { rootDir: 'oms/src' },
  ],
  exportPackageName: 'text-field',
  exports: {
    '.': './exports/lib/runtime/index.js',
    './editor': './exports/lib/editor/index.js',
  },
};
```

### partitions

`partitions` 声明该 domain 的源码根目录。未声明时，项目 domain 默认使用 `src`，扩展 domain 默认使用 `oms/src`。

旧的 `package.json#oms.partitions` 仍然可以作为兼容输入，但公开导出应写在 `oms.config.*` 里。

### exportPackageName

`exportPackageName` 是该扩展对外暴露的 `oms://` 包名。未声明时，默认使用扩展 ID。

```js
export default {
  exportPackageName: 'text-field',
  exports: {
    '.': './exports/lib/runtime/index.js',
  },
};
```

用户侧 import：

```ts
import { TextField } from 'oms://text-field';
```

`exportPackageName` 不能包含 `/` 或 `\`。

### exports

`exports` 的 key 接近 npm package exports：

- `'.'` 表示包根入口，对应 `oms://name`。
- `'./abc'` 表示子路径入口，对应 `oms://name/abc`。
- `'abc'`、`'/abc'` 也会被规范化为 `abc`，但推荐写 npm 风格的 `'./abc'`。

value 必须是以 `./` 开头的扩展内相对路径。

```js
export default {
  exports: {
    '.': './exports/lib/runtime/index.js',
    './abc': './exports/lib/runtime/abc.js',
  },
};
```
