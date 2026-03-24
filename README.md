# cli-in-wechat

在微信中运行 Claude Code、Codex CLI、Gemini CLI、Kimi Code —— 通过微信 ClawBot 官方插件的 iLink Bot API 实现。

```
╔══════════════════════════════════════╗
║       cli-in-wechat  v0.1.0        ║
║  Claude / Codex / Gemini / Kimi    ║
╚══════════════════════════════════════╝
```

## 它是什么

一个运行在你电脑上的桥接服务。微信是遥控器，电脑是执行端。

```
微信 ClawBot (手机)
    ↕  iLink Bot API — 微信官方消息通道 (不封号)
桥接服务 (你的电脑)
    ↕  child_process.spawn / Agent SDK
claude -p / codex exec / gemini -p / kimi --print (本地 CLI)
```

你在微信里发消息，服务调你电脑上的 CLI 工具执行，结果发回微信。

## 功能

- **四大 CLI 工具**: Claude Code、Codex CLI、Gemini CLI、Kimi Code，通过 `@` 前缀随时切换
- **最高权限默认开启**: Claude `--dangerously-skip-permissions`、Codex `--yolo`、Gemini `--approval-mode yolo`、Kimi `--print` (自带 yolo)
- **AskUserQuestion 支持**: Claude Code 需要你做选择时，问题会转发到微信，你回复后 Claude 继续执行（通过 Agent SDK 实现）
- **会话续接**: 连续对话自动保持上下文（Claude `--resume`、Codex `--last`、Gemini `--resume`、Kimi `-S`）
- **跨通道会话漫游**: `/session set <id>` 从终端/其他通道接续同一个会话
- **完整 `/` 命令体系**: 40+ 命令覆盖四个 CLI 的所有核心 flag
- **工具接力**: `>>` 传递上条结果，`@tool1>tool2` 链式调用
- **typing 指示器**: 处理中显示"正在输入"
- **微信官方通道**: 使用 iLink Bot API (ClawBot 插件)，不封号

## 安装

### 前置要求

- **Node.js** >= 18
- **微信** iOS 8.0.70+，已启用 ClawBot 插件 (我 → 设置 → 插件)
- 至少一个 CLI 工具:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# Codex CLI
npm install -g @openai/codex

# Gemini CLI
npm install -g @google/gemini-cli

# Kimi Code
curl -LsSf https://code.kimi.com/install.sh | bash
# 或: uv tool install --python 3.13 kimi-cli
```

### 安装并运行

```bash
git clone https://github.com/sgaofen/cli-in-wechat.git
cd cli-in-wechat
npm install
npm run dev
```

首次运行会在终端显示 QR 码，用微信扫码登录 ClawBot。凭据保存在 `~/.wx-ai-bridge/`，后续自动复用。

#### 调试模式

```bash
npm run dev -- --debug
```

#### 生产构建

```bash
npm run build
npm start
```

### CLI 工具认证

每个工具需要单独登录:

```bash
# Claude Code — Anthropic 订阅账号
claude

# Codex — ChatGPT 账号
codex

# Gemini — API key 或 OAuth
export GEMINI_API_KEY="your-key"
# 或直接运行 gemini 触发浏览器 OAuth
gemini

# Kimi Code — OAuth
kimi login
```

## 使用方法

### 发消息

| 输入 | 行为 |
|---|---|
| 直接打字 | 发给上次使用的工具 (默认 Claude) |
| `@claude 写排序算法` | 用 Claude Code |
| `@codex fix the bug` | 用 Codex CLI |
| `@gemini 解释代码` | 用 Gemini CLI |
| `@kimi 重构这个模块` | 用 Kimi Code |

切换工具后，后续消息默认发给该工具，不用每次都加 `@`。

### 工具接力

```
@claude 分析这个项目的架构
>> @codex 根据上面的分析，重构代码    ← Claude 的输出作为 Codex 的上下文
>> 继续优化                           ← 继续用 Codex，带上之前的结果
@claude>codex 先分析再修复            ← 链式: Claude 分析 → Codex 执行
@gemini>kimi 先规划再实现             ← Gemini 规划 → Kimi 实现
```

### AskUserQuestion (Claude Code)

当 Claude Code 需要你做选择时，问题会自动转发到微信：

```
你发: @claude 帮我新建一个项目

微信收到:
  Claude 需要你的回答:

  ❓ What programming language should I use?
    1. Python
    2. TypeScript — Great for full-stack apps
    3. Rust — Systems programming

  请直接回复选项编号或内容:

你回复: 2

Claude 收到 "TypeScript"，继续执行...
```

通过 `@anthropic-ai/claude-agent-sdk` 的 `canUseTool` 回调实现，完整保留 Claude Code 的交互能力。

### 跨通道会话漫游

```
# 终端里用 Claude Code 干了一半
claude   # 看到 session ID: abc-123-def

# 微信里接续同一个会话
/session set abc-123-def
继续之前的工作    ← Claude 读取终端里的完整上下文

# 查看当前会话 ID
/session          ← 显示完整 ID，可复制到其他通道
```

## 完整命令列表

所有 `/` 开头的消息都是命令，不会被发给 CLI 工具。

### 设置类

| 命令 | 作用 | 对应 CLI flag |
|---|---|---|
| `/status` | 查看所有当前设置 | — |
| `/model <名>` | 切换模型 (`reset`=默认) | 所有工具: `--model` / `-m` |
| `/mode <auto\|safe\|plan>` | 权限模式 | 见下方权限模式表 |
| `/dir <路径>` | 切换工作目录 | `cwd` / `-w` |
| `/system <提示词>` | 追加系统提示 (`clear`=清除) | Claude: `--append-system-prompt` |
| `/reset` | 重置所有设置为默认 | — |

#### Claude Code 专属

| 命令 | 作用 | 对应 flag |
|---|---|---|
| `/effort <low\|med\|high\|max>` | 思考深度 | `--effort` |
| `/turns <数字>` | 最大 agent 轮次 | `--max-turns` |
| `/budget <美元>` | API 预算 (`off`=无限) | `--max-budget-usd` |
| `/tools <列表>` | 允许的工具 (逗号分隔) | `--allowedTools` |
| `/notool <列表>` | 禁用的工具 | `--disallowedTools` |
| `/verbose` | 切换详细输出 | `--verbose` |
| `/bare` | 切换 bare 模式 (跳过配置加载) | `--bare` |
| `/adddir <路径>` | 添加额外目录访问 | `--add-dir` |
| `/name <名>` | 会话命名 | `--name` |

#### Codex CLI 专属

| 命令 | 作用 | 对应 flag |
|---|---|---|
| `/sandbox <ro\|write\|full\|off>` | 沙箱级别 | `--sandbox` |
| `/search` | 切换 web 搜索 | `--search` |
| `/ephemeral` | 切换临时模式 (不存 session) | `--ephemeral` |
| `/profile <名>` | 加载配置 profile | `--profile` |

#### Kimi Code 专属

| 命令 | 作用 | 对应 flag |
|---|---|---|
| `/thinking` | 切换深度思考模式 | `--thinking` / `--no-thinking` |

#### Gemini CLI 专属

| 命令 | 作用 | 对应 flag |
|---|---|---|
| `/approval <模式>` | 审批模式 (`default\|auto_edit\|yolo\|plan`) | `--approval-mode` |
| `/include <目录>` | 添加上下文目录 | `--include-directories` |
| `/ext <名\|none>` | 指定 extensions | `-e` |

### 操作类

| 命令 | 作用 |
|---|---|
| `/diff [说明]` | 查看 git 差异 |
| `/commit [说明]` | 创建 git 提交 |
| `/review [说明]` | 代码审查 |
| `/plan [描述]` | 制定计划 / 切换 plan 模式 |
| `/init` | 创建项目配置文件 (CLAUDE.md / AGENTS.md / GEMINI.md) |
| `/files` | 列出目录结构 |
| `/compact` | 压缩上下文 (清除 session 重新开始) |
| `/stats` | 查看上次回复信息 |

### 会话类

| 命令 | 作用 |
|---|---|
| `/new` | 新会话 (清除所有工具 session) |
| `/clear` | 清除所有会话和历史 |
| `/cancel` | 取消正在运行的任务 (SIGTERM) |
| `/fork` | 分支当前会话 |
| `/resume` | 查看保存的会话 ID |
| `/session` | 查看完整会话 ID (可复制) |
| `/session set <id>` | 手动设置 session ID (跨通道漫游) |

### 快捷命令

| 命令 | 等效 |
|---|---|
| `/yolo` | `/mode auto` + `/effort max` |
| `/fast` | `/effort low` |
| `/cc` | 切到 Claude Code |
| `/cx` | 切到 Codex CLI |
| `/gm` | 切到 Gemini CLI |
| `/km` | 切到 Kimi Code |

### 终端专属 (微信中不可用)

以下命令仅在本地终端有效，在微信中会提示不可用：

`/vim` `/theme` `/color` `/terminal-setup` `/keybindings` `/chrome` `/ide` `/stickers` `/mobile` `/login` `/logout` `/doctor` `/upgrade` `/exit` `/quit` 等

## 权限模式

`/mode` 命令统一控制四个工具的权限级别:

| 模式 | Claude Code | Codex CLI | Gemini CLI | Kimi Code |
|---|---|---|---|---|
| `auto` (默认) | `--dangerously-skip-permissions` | `--yolo` | `--approval-mode yolo` | `--print` (自带 yolo) |
| `safe` | 默认权限 | `--full-auto` | `--approval-mode default` | 默认 |
| `plan` | `--permission-mode plan` | `--sandbox read-only` | `--approval-mode plan` | `/plan` |

## 配置

配置文件: `~/.wx-ai-bridge/config.json`

```jsonc
{
  "defaultTool": "claude",         // 默认工具: claude/codex/gemini/kimi
  "workDir": "/Users/you",         // CLI 工作目录
  "cliTimeout": 300000,            // 超时 ms (默认 5 分钟)
  "allowedUsers": [],              // 允许的微信用户 ID (空=不限)
  "tools": {                       // 每个工具的额外 CLI 参数
    "claude": { "args": ["--max-turns", "50"] },
    "codex": { "args": ["--add-dir", "/tmp"] },
    "kimi": { "args": ["--thinking"] }
  }
}
```

### 数据存储

```
~/.wx-ai-bridge/
├── config.json           # 配置
├── credentials.json      # 微信 iLink 登录凭据
├── poll_cursor.txt       # 消息轮询游标
└── sessions/
    └── sessions.json     # 用户设置 + 会话 ID
```

## 架构

```
src/
├── index.ts              # 入口: 启动、QR 登录、信号处理
├── config.ts             # 配置管理 (~/.wx-ai-bridge/)
├── ilink/
│   ├── types.ts          # iLink 协议完整类型定义
│   ├── auth.ts           # QR 扫码登录 (获取→轮询→凭据持久化)
│   └── client.ts         # 长轮询 + 发消息 + typing 指示器 + context_token 缓存
├── adapters/
│   ├── base.ts           # CLIAdapter 接口 + UserSettings (40+ 字段)
│   ├── claude.ts         # Agent SDK (AskUserQuestion) + CLI 降级
│   ├── codex.ts          # codex exec --yolo + session resume --last
│   ├── gemini.ts         # gemini -p --approval-mode yolo + --resume
│   ├── kimi.ts           # kimi --print + --thinking + -S session
│   ├── aider.ts          # aider -m --yes-always
│   └── registry.ts       # 自动检测已安装工具 (which/where 跨平台)
└── bridge/
    ├── session.ts        # 会话 + 设置持久化 (per user)
    ├── formatter.ts      # 响应格式化 (工具名 + 耗时)
    └── router.ts         # 核心路由:
                          #   @ 前缀工具切换
                          #   / 命令体系 (40+ 命令)
                          #   >> 接力传递
                          #   @tool1>tool2 链式调用
                          #   AskUserQuestion 微信转发
                          #   pending question 等待回复机制
```

### Claude Code 特殊处理

Claude adapter 优先使用 `@anthropic-ai/claude-agent-sdk`，通过 `canUseTool` 回调拦截 `AskUserQuestion`，将问题转发到微信并等待用户回复。如果 SDK 失败，自动降级到 `child_process.spawn` 调用 `claude -p`。

### 添加新 CLI 工具

实现 `CLIAdapter` 接口 (~50-100 行)，在 `registry.ts` 中注册:

```typescript
// src/adapters/my-tool.ts
import { spawn } from 'node:child_process';
import { commandExists, setupAbort, setupTimeout, stripAnsi } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class MyToolAdapter implements CLIAdapter {
  readonly name = 'mytool';
  readonly displayName = 'My Tool';
  readonly command = 'mytool';
  readonly capabilities: AdapterCapabilities = {
    streaming: false, jsonOutput: false, sessionResume: false,
    modes: ['auto', 'safe'], hasEffort: false, hasModel: true,
    hasSearch: false, hasBudget: false,
  };

  async isAvailable() { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const proc = spawn(this.command, ['--flag', prompt], {
        cwd: opts.settings.workDir || opts.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ text: stripAnsi(stdout.trim()), error: code !== 0 });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: err.message, error: true });
      });
    });
  }
}
```

在 `registry.ts` 注册后，`@mytool` 和 `/mytool` 即可使用。

## 微信 iLink Bot API

本项目使用微信 2026 年 3 月推出的 ClawBot 插件提供的官方 iLink Bot API:

- **域名**: `ilinkai.weixin.qq.com` (腾讯官方服务器)
- **认证**: QR 扫码 → Bearer token
- **收消息**: HTTP 长轮询 (35 秒超时)
- **发消息**: POST + `context_token` (必须从入站消息中获取)
- **消息类型**: 文本、图片 (AES-128-ECB)、语音 (含转写)、文件、视频
- **限制**: 仅私聊 (暂不支持群聊)、无消息历史 API
- **官方通道，不封号**

## License

MIT
