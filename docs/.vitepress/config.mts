import { defineConfig } from 'vitepress';

export default defineConfig({
  cleanUrls: true,
  markdown: {
    theme: {
      light: 'light-plus',
      dark: 'dark-plus',
    },
  },
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Oh My Script 文档',
      description: 'Cocos Creator 项目脚本与扩展导出系统',
      themeConfig: {
        nav: [
          { text: '指南', link: '/getting-started' },
        ],
        sidebar: [
          {
            text: '开始使用',
            items: [
              { text: '总览', link: '/' },
              { text: '快速开始', link: '/getting-started' },
              { text: '从 Cocos Creator 脚本系统迁移', link: '/migration-from-cocos' },
            ],
          },
          {
            text: '核心机制',
            items: [
              {
                text: '脚本类型',
                link: '/script-types',
                items: [
                  { text: '组件脚本', link: '/component-scripts' },
                ],
              },
              { text: '模块解析', link: '/module-resolution' },
              { text: '插件 API', link: '/plugins-api' },
              { text: '模块热更', link: '/hot-reload' },
              { text: 'Headless 模式', link: '/headless-mode' },
            ],
          },
        ],
      },
    },
  },
  themeConfig: {
    outline: {
      level: [2, 3],
    },
    search: {
      provider: 'local',
    },
  },
});
