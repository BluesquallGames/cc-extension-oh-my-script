# Oh My Script 文档

Oh My Script 是一套替代 Cocos Creator 内置脚本链路的项目脚本系统。它把“脚本放在哪里、组件怎么声明、UUID 怎么保持稳定、代码怎么在编辑器里刷新、最终怎么进入构建”重新整理成一套更接近现代 TypeScript/npm 工程的工作方式。

使用 OMS 后，你可以把项目脚本放在独立的源码目录里，用约定好的文件名声明组件，让 OMS 自动处理组件注册、UUID、刷新和构建。扩展也可以把自己的能力包装成 `oms://` 入口，项目代码像使用 npm 包一样 import。

## 核心特色

- **组件按文件声明**：`*.component.ts` / `*.component.editor.ts` 会被自动识别。你专心写组件类，不用反复维护传统脚本资源关系。
- **UUID 稳定可控**：OMS 会为组件脚本维护稳定 UUID。需要把 UUID 固定到源码里时，可以用 Inline UUID 写回。
- **源码组织更自由**：项目脚本默认放在 `src`，扩展脚本默认放在 `oms/src`，也可以通过配置调整。
- **编辑器里自动刷新**：脚本或配置变化后，OMS 会重新构建并刷新脚本，不需要手动整理一堆生成文件。
- **接近 npm 的扩展 API**：扩展可以声明公开导出，项目用 `import { X } from 'oms://package-name'` 使用。
- **TypeScript 体验完整**：OMS 会为 `oms://` 入口生成声明，IDE 可以提示导出的符号。
- **支持构建外复用**：需要在测试、工具脚本或非场景环境复用逻辑时，可以开启 headless 输出。

## 当前主题

- [快速开始](./getting-started.md)
- [从 Cocos Creator 脚本系统迁移](./migration-from-cocos.md)
- [脚本类型](./script-types.md)
  - [组件脚本](./component-scripts.md)
- [模块解析](./module-resolution.md)
- [模块热更](./hot-reload.md)
- [Headless 模式](./headless-mode.md)
