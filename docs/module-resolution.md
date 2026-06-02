# 模块解析

OMS 的 import 写法更接近普通 TypeScript/npm 项目。项目脚本可以 import 本地文件、npm 包、别名路径，也可以 import 扩展暴露出来的 `oms://` 模块。

## 相对路径

普通相对路径照常使用：

```ts
import { clamp01 } from './math/clamp';
import { createEnemy } from '../battle/enemy';
```

## npm 包

可以直接 import 项目依赖：

```ts
import { nanoid } from 'nanoid';
```

依赖应安装在项目或扩展能解析到的位置。OMS 会按 Node/npm 的模块解析习惯查找包。

## pnpm 和 workspace

OMS 支持 pnpm workspace、软链接、junction 和包管理器生成的真实安装路径。对用户来说，不需要把依赖复制到 `assets` 里，也不需要为了 Creator 的脚本系统调整包目录。

如果扩展公开导出依赖了自己的传递依赖，OMS 生成的类型也会尽量保持在真实包上下文中解析，避免因为展示路径不同导致 IDE 看不到导出符号。

## 项目 Peer 依赖

有时候项目和扩展都依赖同一个包，而你希望最终运行时只使用项目根目录安装的那一份，避免同一个库在项目和扩展里各打进来一份。

项目可以在根目录 `oms.config.*` 里声明 `resolve.projectPeers`：

```js
export default {
  resolve: {
    projectPeers: ['shared-runtime', '@scope/ui-kit'],
  },
};
```

扩展代码可以用 `#oms-peer:` 显式声明“这个包由项目提供”：

```ts
import { createSomething } from '#oms-peer:shared-runtime';
import { Button } from '#oms-peer:@scope/ui-kit/button';
```

OMS 会去掉 `#oms-peer:` 前缀，然后从项目根目录解析真实包名。这个规则不关心 importer 在哪里，所以扩展依赖包、workspace link、pnpm store 里的文件也可以显式使用它。

`#oms-peer:` 是强约束：项目必须安装并允许这个包。如果项目没有安装，OMS 会报错，而不是回退到扩展自己的依赖。

`projectPeers` 只写包名，不写子路径：

```js
export default {
  resolve: {
    projectPeers: ['react', '@scope/shared'],
  },
};
```

上面的 `react` 会允许 `#oms-peer:react`、`#oms-peer:react/jsx-runtime` 这类 import；`@scope/shared` 会允许 `#oms-peer:@scope/shared` 及其子路径。

## alias

项目可以在根目录 `oms.config.*` 中配置 alias：

```js
export default {
  resolve: {
    alias: {
      '@game': './src',
      '@shared': './shared',
    },
  },
};
```

使用：

```ts
import { createActor } from '@game/actor';
```

## oms:// 模块

项目内扩展可以声明公开入口：

```js
export default {
  exportPackageName: 'text-field',
  exports: {
    '.': './exports/lib/runtime/index.js',
    './editor': './exports/lib/editor/index.js',
  },
};
```

项目代码使用：

```ts
import { TextField } from 'oms://text-field';
import { createTextFieldInspector } from 'oms://text-field/editor';
```

`oms://` 适合扩展对项目暴露稳定 API。用户代码不应该直接 import 扩展内部文件路径。
