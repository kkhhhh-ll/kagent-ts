# Git Worktree 隔离

Git Worktree 隔离为并行子代理提供**文件系统级别的隔离**。当多个子代理同时修改同一仓库时，每个子代理获得独立的 worktree，互不干扰，完成后可选择合并回主分支。

## 为什么需要 Worktree？

多个子代理并行操作同一个仓库时，如果不隔离：

```
子代理 A: 修改文件 X → 子代理 B 同时读取/修改文件 X → 冲突/脏读
```

启用 worktree 后：

```
主仓库 (main)
  ├── worktree A (分支 kagent/node-a) → 子代理 A 独立操作
  ├── worktree B (分支 kagent/node-b) → 子代理 B 独立操作
  └── worktree C (分支 kagent/node-c) → 子代理 C 独立操作
```

每个 worktree 是 Git 原生的独立工作目录，拥有各自的分支和文件系统状态。

## 基本用法

```ts
import { GitWorktreeManager } from 'kagent-ts'

const manager = new GitWorktreeManager({
  repoPath: '/path/to/your/repo',
})

// 创建 worktree
const wt = await manager.createWorktree({
  nodeId: 'task-1',
  baseRef: 'main',
})

console.log(wt.path)  // "/path/to/your/repo/.kagent-worktrees/kagent-task-1"

// ... 子代理在 wt.path 下工作 ...

// 完成后：合并且清理
await manager.removeWorktree(wt.id, {
  mergeBack: true,
  deleteBranch: true,
})
```

## 配置

```ts
interface GitWorktreeConfig {
  /** 仓库根目录（必填），必须包含 .git 文件夹 */
  repoPath: string

  /** Worktree 父目录（默认: "<repoPath>/.kagent-worktrees/"） */
  worktreesDir?: string

  /** 默认基础引用（默认: "HEAD"） */
  defaultBaseRef?: string

  /** 分支名前缀（默认: "kagent"） */
  branchPrefix?: string

  /** 是否在操作完成后自动清理（默认: true） */
  autoCleanup?: boolean

  /** 日志实例 */
  logger?: Logger
}
```

## 创建 Worktree

```ts
interface CreateWorktreeOptions {
  /** 分支名（不传则自动生成 "kagent/{nodeId}"） */
  branchName?: string

  /** 基础引用（覆盖 config.defaultBaseRef） */
  baseRef?: string

  /** 关联的 TaskNode ID */
  nodeId?: string

  /** 自定义元数据 */
  metadata?: Record<string, string>
}

const wt = await manager.createWorktree({
  nodeId: 'analyze-core',
  baseRef: 'main',
  metadata: { priority: 'high' },
})
```

## 移除 Worktree

```ts
interface RemoveWorktreeOptions {
  /** 强制移除（即使有未提交更改），默认: false */
  force?: boolean

  /** 合并回目标分支，默认: false */
  mergeBack?: boolean

  /** 合并目标分支（默认: worktree 创建时的 baseRef） */
  mergeTarget?: string

  /** 是否删除 worktree 分支，默认: false */
  deleteBranch?: boolean

  /** 合并后推送到远程（仅 mergeBack=true 时有效），默认: false */
  pushAfterMerge?: boolean
}

// 仅清理，不合并
await manager.removeWorktree(wt.id)

// 合并且推送
await manager.removeWorktree(wt.id, {
  mergeBack: true,
  deleteBranch: true,
  pushAfterMerge: true,
})
```

## 执行流程

```
[创建] createWorktree()
  ├── git worktree add <path> <baseRef>
  ├── git checkout -b kagent/<nodeId>
  └── 返回 WorktreeInfo { id, path, branchName }

[使用] 子代理在 worktree.path 下工作
  ├── 文件读写、git 操作均隔离
  └── 不影响主仓库

[清理] removeWorktree()
  ├── (可选) git merge kagent/<nodeId> → baseRef
  ├── (可选) git push
  ├── git worktree remove <path>
  └── (可选) git branch -d kagent/<nodeId>
```

## 错误处理

所有 Worktree 操作失败时抛出 `GitWorktreeError`：

```ts
import { GitWorktreeError } from 'kagent-ts'

try {
  await manager.createWorktree({ nodeId: 'task-1' })
} catch (err) {
  if (err instanceof GitWorktreeError) {
    switch (err.code) {
      case 'GIT_NOT_FOUND':        // 系统未安装 Git
      case 'BRANCH_EXISTS':        // 分支名冲突
      case 'WORKTREE_CREATE_FAILED': // 创建失败
      case 'WORKTREE_DIRTY':       // 有未提交更改（force: false 时）
      case 'MERGE_CONFLICT':       // 合并冲突
      case 'PERMISSION_DENIED':    // 权限不足
      case 'INVALID_CONFIG':       // 配置无效
        console.error(`操作失败: ${err.message} (code: ${err.code})`)
    }
  }
}
```

## Worktree 状态

```ts
const status = await manager.getWorktreeStatus(wt.id)
// {
//   exists: true,
//   info: { id, path, branchName, status, isDirty, ... },
//   branchExists: true,
//   isDirty: false,
//   gitStatus: "nothing to commit, working tree clean"
// }
```

## 列出所有 Worktree

```ts
const worktrees = await manager.listWorktrees()
for (const wt of worktrees) {
  console.log(`${wt.id}: ${wt.path} [${wt.status}]`)
}
```

## 会话持久化

Worktree 状态支持 Checkpoint 持久化。中断恢复后，Orchestrator 自动还原 worktree 注册表：

```ts
// 获取当前状态
const state = manager.getSessionState()

// 恢复时重建管理器
const restored = new GitWorktreeManager(config, state)
```

## Orchestrator 集成

在 [Orchestrator Agent](/core/orchestrator-agent) 中，worktree 隔离可以通过配置直接启用，无需手动调用 `GitWorktreeManager`：

```ts
const agent = new OrchestratorAgent({
  provider,
  enableWorktrees: true,
  worktreeRepoPath: '/path/to/repo',
  autoMergeWorktrees: true,
  autoCleanupWorktrees: true,
})
```

详见 [Orchestrator Agent](/core/orchestrator-agent#git-worktree-隔离) 的 Worktree 章节。

## 下一步

- [Orchestrator Agent](/core/orchestrator-agent) — Worktree 隔离在编排中的完整用法
- [Sub-Agent 子代理](/advanced/subagents) — 子代理的定义与调度
- [会话持久化](/advanced/session) — Worktree 状态的 Checkpoint 机制
