# 快速开始

## 基本工作流

启用 Oh My Script 扩展后，OMS 会在编辑器启动和项目扩展变更时构建脚本。默认情况下：

- 项目脚本写在项目根目录的 `src`。
- 组件脚本用 `*.component.ts` 命名。
- 扩展自己的 OMS 脚本写在扩展根目录的 `oms/src`。
- OMS 会生成运行所需的临时文件和类型声明，这些生成物不需要手写维护。

推荐把下面这些路径放进 `.gitignore`：

```text
temp/oms
assets/oms.ts
```

## 项目脚本

在项目根目录创建 `src/index.ts`。这个文件适合放初始化逻辑，或者导出项目脚本需要共享的内容：

```ts
console.log('OMS script loaded');
```

## 声明组件

创建 `src/game-boot.component.ts`：

```ts
import { Component, _decorator } from 'cc';

const { ccclass } = _decorator;

@ccclass('GameBoot')
export class GameBoot extends Component {
  start() {
    console.log('OMS script loaded');
  }
}
```

只要文件名带有 `.component`，OMS 就会把它当作组件脚本处理，并为它维护 UUID。组件类仍然按 Cocos Creator 的方式写 `@ccclass`、继承 `Component`。

如果只想在编辑器侧使用，可以写成：

```text
src/my-tool.component.editor.ts
```

## 使用扩展导出

如果扩展 `text-field` 在 `oms.config.mjs` 中声明了根导出：

```js
export default {
  exports: {
    '.': './exports/lib/runtime/index.js',
  },
};
```

项目代码就可以这样使用：

```ts
import { TextField } from 'oms://text-field';
```

如果导出声明为 `./editor`：

```js
export default {
  exports: {
    './editor': './exports/lib/editor/index.js',
  },
};
```

则 import 写法是：

```ts
import { createTextFieldInspector } from 'oms://text-field/editor';
```

## TypeScript 配置

OMS 不再要求用户维护 `compilerOptions.paths`。项目只需要把生成的 OMS 类型加入 `types`：

```json
{
  "compilerOptions": {
    "types": ["./temp/oms/typing"]
  }
}
```

第一次打开项目时，需要先让 OMS 完成一次构建，IDE 才能拿到最新的 `oms://` 声明。
