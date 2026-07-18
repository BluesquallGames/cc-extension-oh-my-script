# Headless 模式

Headless 模式用于把一部分 OMS 代码提供给非场景环境使用。典型场景是自动化测试、离线工具、服务端脚本，或者把纯逻辑模块复用到没有 Cocos 场景的运行环境里。

## 启用方式

配置 `profiles.headless` 即可启用：

```js
export default {
  profiles: {
    headless: {},
  },
};
```

也可以为 default 与 headless 配置各自的组件扫描视图：

```js
export default {
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

## include 和 exclude

`include` 与 `exclude` 使用 glob 规则，匹配的是相对项目 domain 根目录的路径。它们只控制 `.component.*` 脚本的自动收集，不会阻止入口显式导入对应目录中的普通模块。

- `profiles.default` 暂时只支持 `exclude`，未配置时会收集全部普通组件。
- `profiles.headless.include` 未配置时会收集全部普通组件，显式配置为空数组时不自动收集组件。
- `exclude` 命中时不会自动收集该组件，并且优先于 `include`。
- 同一个组件可以同时被 default 与 headless 收集；headless 的 `include` 不会把组件从 default 中移走。

过滤规则描述的是 profile 的 primary 组件视图。Preview 和生产构建只运行 primary；编辑器开发构建还会生成 editor overlay，把 primary 未收集的普通组件和所有 `.component.editor.*` 组件补入 editor entry。因此，编辑器仍能注册完整组件集合，而 Preview 保持 default 的过滤边界。

## Headless 入口

两个 profile 使用各自的入口文件：

```text
src/index-pre.ts
src/index.ts
src/index-pre.headless.ts
src/index.headless.ts
```

入口文件不受组件过滤器影响。开发与生产构建采用相同的 primary profile 边界：default 构建只运行 default 入口，headless 构建只运行 headless 入口；仅编辑器开发态会额外运行 default 的 editor entry 和组件补集。

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
