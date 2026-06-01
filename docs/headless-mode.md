# Headless 模式

Headless 模式用于把一部分 OMS 代码提供给非场景环境使用。典型场景是自动化测试、离线工具、服务端脚本，或者把纯逻辑模块复用到没有 Cocos 场景的运行环境里。

## 启用方式

最简单的方式：

```js
export default {
  headless: true,
};
```

也可以写成对象：

```js
export default {
  headless: {
    enabled: true,
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.editor.ts'],
    build: {
      target: 'node18',
    },
  },
};
```

## include 和 exclude

`include` 与 `exclude` 使用 glob 规则，匹配的是相对源码根目录的路径。

- `include` 存在时，只有命中的文件会进入 Headless 模式。
- `exclude` 命中时，该文件不会进入 Headless 模式。

## Headless 入口

可以使用专门的入口文件：

```text
src/index-pre.headless.ts
src/index.headless.ts
```

这适合放测试、工具或非场景环境需要执行的初始化逻辑。

## 生成内容

开启后会额外生成：

```text
temp/oms/out-headless
temp/oms/typing-headless
```

它们都是生成物，不需要提交。

## 适合放什么代码

适合：

- 不直接依赖场景节点的纯逻辑。
- 数据处理、规则计算、配置转换。
- 测试和工具脚本需要复用的模块。

不适合：

- 需要挂到场景节点上的组件行为。
- 强依赖编辑器 UI 或场景上下文的代码。
