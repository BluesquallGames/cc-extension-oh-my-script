# 脚本类型

OMS 支持 JavaScript 和 TypeScript，也支持常见的 ESM/CJS 文件扩展名。你可以按脚本职责选择文件名，OMS 会根据约定把它们放到合适的位置。

## 支持的文件扩展名

OMS 识别这些源码文件：

```text
.ts
.mts
.cts
.js
.mjs
.cjs
```

项目里可以混用 TypeScript 和 JavaScript。推荐新代码优先使用 `.ts`。

## 普通模块

普通模块就是被其他脚本 import 的文件。它们没有特殊命名要求。

```text
src/math/vector.ts
src/ui/theme.ts
src/data/config.js
```

示例：

```ts
export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
```

普通模块不会因为存在于目录里就自动执行。需要被入口脚本或组件脚本 import 后才会参与使用。

## 入口脚本

入口脚本用于放启动逻辑、注册逻辑或需要主动执行的模块。

项目根 `src` 下常用：

```text
src/index-pre.ts
src/index.ts
```

`index-pre` 会比普通入口更早执行，适合放初始化环境的代码。多数项目只需要 `index.ts`。

编辑器侧入口可以写：

```text
src/index-pre.editor.ts
src/index.editor.ts
```

Headless 入口可以写：

```text
src/index-pre.headless.ts
src/index.headless.ts
```

## 组件脚本

组件脚本使用 `.component` 命名：

```text
src/player.component.ts
src/player.component.js
```

编辑器侧组件脚本：

```text
src/player-tool.component.editor.ts
```

组件脚本会被 OMS 自动收集，并获得稳定 UUID。详细规则见 [组件脚本](./component-scripts.md)。

## 扩展脚本

项目内扩展默认使用自己的 `oms/src`：

```text
extensions/my-extension/oms/src/index.ts
extensions/my-extension/oms/src/widget.component.ts
```

扩展也可以通过 `oms.config.*` 调整源码目录。
