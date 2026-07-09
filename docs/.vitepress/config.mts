import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'kagent-ts',
  description: '一个 TypeScript AI Agent 框架 — ReAct / Plan-Solve / Fusion / Orchestrator 多模式支持',
  lang: 'zh-CN',
  base: '/kagent-ts/',

  head: [
    ['link', { rel: 'icon', href: '/kagent-ts/favicon.ico' }],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config#logo
    // logo: '/logo.svg',

    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: '核心概念', link: '/core/overview' },
      { text: 'LLM 后端', link: '/llm/overview' },
      { text: '工具系统', link: '/tools/overview' },
      { text: '高级功能', link: '/advanced/session' },
      { text: 'API 参考', link: '/api/' },
      { text: 'GitHub', link: 'https://github.com/kkhhhh-ll/kagent-ts' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '入门指南',
          items: [
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '安装', link: '/guide/installation' },
            { text: '配置', link: '/guide/configuration' },
          ],
        },
      ],
      '/core/': [
        {
          text: '核心概念',
          items: [
            { text: '概述', link: '/core/overview' },
            { text: 'Agent 基类', link: '/core/agent' },
            { text: 'ReAct Agent', link: '/core/react-agent' },
            { text: 'Plan-Solve Agent', link: '/core/plan-solve-agent' },
            { text: 'Fusion Agent', link: '/core/fusion-agent' },
            { text: 'Orchestrator Agent', link: '/core/orchestrator-agent' },
            { text: '生命周期钩子', link: '/core/hooks' },
          ],
        },
      ],
      '/llm/': [
        {
          text: 'LLM 后端',
          items: [
            { text: '概述', link: '/llm/overview' },
            { text: 'OpenAI Provider', link: '/llm/openai' },
            { text: 'Anthropic Provider', link: '/llm/anthropic' },
            { text: 'Fallback Provider', link: '/llm/fallback' },
            { text: 'Rate Limiter', link: '/llm/rate-limiter' },
            { text: 'Model Router', link: '/llm/model-router' },
            { text: 'Token Budget', link: '/llm/token-budget' },
          ],
        },
      ],
      '/tools/': [
        {
          text: '工具系统',
          items: [
            { text: '概述', link: '/tools/overview' },
            { text: 'Tool Registry', link: '/tools/tool-registry' },
            { text: 'Circuit Breaker', link: '/tools/circuit-breaker' },
            { text: '参数验证', link: '/tools/validation' },
            { text: '工具过滤器', link: '/tools/filters' },
            { text: '内置工具', link: '/tools/builtin-tools' },
            { text: 'HITL 审批', link: '/tools/approval' },
          ],
        },
      ],
      '/advanced/': [
        {
          text: '高级功能',
          items: [
            { text: '会话持久化', link: '/advanced/session' },
            { text: '上下文管理', link: '/advanced/context-compression' },
            { text: 'Skill 渐进式技能', link: '/advanced/skills' },
            { text: 'Skill Precipitation 技能沉淀', link: '/advanced/precipitation' },
            { text: 'Sub-Agent 子代理', link: '/advanced/subagents' },
            { text: 'Git Worktree 隔离', link: '/advanced/git' },
            { text: 'MCP 协议', link: '/advanced/mcp' },
            { text: 'RAG 知识库', link: '/advanced/rag' },
            { text: 'Reflection 反思', link: '/advanced/reflection' },
            { text: 'Memory 记忆', link: '/advanced/memory' },
            { text: 'Preferences 偏好', link: '/advanced/preferences' },
            { text: 'Rules 项目规则', link: '/advanced/rules' },
            { text: '安全防护', link: '/advanced/security' },
            { text: 'Eval 评估', link: '/advanced/eval' },
            { text: 'Trace 追踪', link: '/advanced/trace' },
            { text: 'Logging 日志', link: '/advanced/logging' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API 参考',
          items: [
            { text: '总览', link: '/api/' },
            { text: 'Agent 类', link: '/api/agent' },
            { text: 'LLM Provider', link: '/api/llm' },
            { text: 'Tool 系统', link: '/api/tools' },
            { text: 'Message 类型', link: '/api/messages' },
            { text: 'Session', link: '/api/session' },
            { text: 'Context & Compression', link: '/api/context' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/kkhhhh-ll/kagent-ts' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: '基于 MIT 协议发布',
      copyright: `Copyright © ${new Date().getFullYear()} kyk`,
    },

    outline: {
      level: [2, 3],
      label: '页面导航',
    },

    docFooter: {
      prev: '上一页',
      next: '下一页',
    },

    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '返回顶部',
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
})
