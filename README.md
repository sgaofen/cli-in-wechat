# cli-in-wechat

在微信中运行主流 AI 编程 CLI 工具 —— 通过微信 ClawBot 官方 iLink Bot API 实现。

**支持的工具：** Claude Code / Codex CLI / Gemini CLI / Kimi Code / OpenCode

## 它是什么

一个运行在你电脑上的桥接服务。微信是遥控器，电脑是执行端。

```
微信 ClawBot (手机)
    ↕  iLink Bot API — 微信官方消息通道 (不封号)
桥接服务 (你的电脑)
    ↕  spawn / Agent SDK
claude -p / codex exec / gemini -p / kimi --print / opencode -p
```

## 功能

- **5 大 CLI 工具**，通过 `@` 前缀随时切换
- **最高权限默认开启**
- **AskUserQuestion**：Claude Code 的交互式提问转发到微信（Agent SDK）
- **会话续接**：连续对话自动保持上下文
- **`/resume`**：浏览所有历史会话，选编号恢复（类似终端的 `/resume`）
- **跨通道漫游**：`/session set <id>` 从终端接续同一会话
- **工具接力**：`>>` 传递上条结果，`@tool1>tool2` 链式调用
- **40+ `/` 命令**覆盖所有 CLI 核心 flag
- **微信引用消息智能路由**：回复哪条消息就由哪个工具接手

## 安装

### 前置要求

- **Node.js** >= 18
- **微信** 已启用 ClawBot 插件（我 → 设置 → 插件）
- 至少一个 CLI 工具：

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
npm install -g @openai/codex                # Codex CLI
npm install -g @google/gemini-cli           # Gemini CLI
curl -LsSf https://code.kimi.com/install.sh | bash  # Kimi Code
brew install opencode-ai/tap/opencode       # OpenCode
```

### 运行

```bash
git clone https://github.com/sgaofen/cli-in-wechat.git
cd cli-in-wechat
npm install
npm run dev           # 开发模式
npm run dev:debug     # 调试模式
```

首次运行显示 QR 码，用微信扫码登录 ClawBot。

### CLI 工具认证

```bash
claude          # Anthropic 订阅账号
codex           # ChatGPT 账号
gemini          # 设置 GEMINI_API_KEY 或 OAuth
kimi login      # Kimi OAuth
# OpenCode: 设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量
```

## 使用方法

### 发消息

| 输入 | 行为 |
|---|---|
| 直接打字 | 发给上次使用的工具 |
| `@claude 写排序算法` | Claude Code |
| `@codex fix the bug` | Codex CLI |
| `@gemini 解释代码` | Gemini CLI |
| `@kimi 重构模块` | Kimi Code |
| `@opencode 分析项目` | OpenCode |

切换后后续消息默认发给该工具。

### 工具接力

```
@claude 分析这个项目的架构
>> @codex 根据分析修复代码        ← Claude 输出作为 Codex 上下文
>> 继续优化                       ← 继续用 Codex
@claude>codex 先分析再修复        ← 链式调用
```

### 恢复历史会话

```
/resume                          ← 列出所有历史会话 + 摘要
/resume 3                        ← 恢复第 3 个
/session set <uuid>              ← 从终端接续会话
```

### AskUserQuestion

Claude Code 需要你做选择时，问题自动转发到微信：

```
你发: @claude 帮我新建项目

微信收到:
  Claude Code 需要你的回答:
  ❓ What language?
    1. Python
    2. TypeScript
    3. Rust

你回复: 2
→ Claude 继续执行
```

## 完整命令列表

### 设置

| 命令 | 作用 | 工具 |
|---|---|---|
| `/status` | 查看所有配置 | 通用 |
| `/model <名>` | 切模型 | 所有 |
| `/mode <auto\|safe\|plan>` | 权限模式 | 所有 |
| `/effort <low\|med\|high\|max>` | 思考深度 | Claude |
| `/turns <数>` | 最大轮次 | Claude |
| `/budget <$>` | API 预算 | Claude |
| `/dir <路径>` | 工作目录 | 通用 |
| `/system <提示>` | 系统提示 | Claude |
| `/tools <列表>` | 允许工具 | Claude |
| `/notool <列表>` | 禁用工具 | Claude |
| `/verbose` | 详细输出 | Claude |
| `/bare` | 跳过配置加载 | Claude |
| `/adddir <路径>` | 额外目录 | Claude/Codex |
| `/name <名>` | 会话命名 | Claude |
| `/sandbox <ro\|write\|full>` | 沙箱 | Codex |
| `/search` | web 搜索 | Codex |
| `/ephemeral` | 临时模式 | Codex |
| `/profile <名>` | 配置 | Codex |
| `/thinking` | 深度思考 | Kimi |
| `/approval <模式>` | 审批模式 | Gemini |
| `/include <目录>` | 上下文目录 | Gemini |
| `/ext <名>` | Extensions | Gemini |

### 操作

| 命令 | 作用 |
|---|---|
| `/diff` | 查看 git 差异 |
| `/commit` | 创建 git 提交 |
| `/review` | 代码审查 |
| `/plan [描述]` | 规划 / 切 plan 模式 |
| `/init` | 创建项目配置文件 |
| `/files` | 目录结构 |
| `/compact` | 压缩上下文 |
| `/stats` | 使用统计 |

### 会话

| 命令 | 作用 |
|---|---|
| `/new` | 新会话 |
| `/clear` | 清除所有 |
| `/cancel` | 取消任务 |
| `/fork` | 分支会话 |
| `/resume` | 浏览历史会话，选编号恢复 |
| `/resume <编号\|uuid>` | 恢复指定会话 |
| `/session` | 查看当前会话 ID |
| `/session set <id>` | 跨通道漫游 |

### 快捷

| 命令 | 等效 |
|---|---|
| `/yolo` | mode=auto + effort=max |
| `/fast` | effort=low |
| `/reset` | 重置所有设置 |
| `/cc` `/cx` `/gm` `/km` `/oc` | 快速切工具 |

## 权限模式

| 模式 | Claude | Codex | Gemini | Kimi | OpenCode |
|---|---|---|---|---|---|
| `auto` | `--dangerously-skip-permissions` | `--yolo` | `--approval-mode yolo` | `--print` (自带) | `-p` (自带) |
| `safe` | 默认权限 | `--full-auto` | `--approval-mode default` | 默认 | — |
| `plan` | `--permission-mode plan` | `--sandbox read-only` | `--approval-mode plan` | — | — |

## 配置

`~/.wx-ai-bridge/config.json`：

```jsonc
{
  "defaultTool": "claude",
  "workDir": "/Users/you",
  "cliTimeout": 300000,
  "allowedUsers": [],
  "tools": {
    "claude": { "args": ["--max-turns", "50"] }
  }
}
```

## 架构

```
src/
├── index.ts              # 入口
├── config.ts             # 配置
├── ilink/                # 微信 iLink Bot API
│   ├── types.ts          # 协议类型
│   ├── auth.ts           # QR 扫码登录
│   └── client.ts         # 长轮询 + 发消息 + typing
├── adapters/             # CLI 工具适配器
│   ├── base.ts           # 接口 + 共享 helpers (跨平台 spawn)
│   ├── claude.ts         # Agent SDK + CLI 降级
│   ├── codex.ts          # codex exec + stdin 传参
│   ├── gemini.ts         # gemini -p + stdin 传参
│   ├── kimi.ts           # kimi --print + --thinking
│   ├── opencode.ts       # opencode -p -f json
│   └── registry.ts       # 自动检测已安装工具
└── bridge/               # 桥接逻辑
    ├── session.ts        # 会话持久化
    ├── formatter.ts      # 响应格式化
    └── router.ts         # @ 路由 + / 命令 + >> 接力 + 链式调用
                          # + /resume 历史会话浏览
                          # + AskUserQuestion 微信转发
```

## 微信 iLink Bot API

微信 2026 年 3 月推出的 ClawBot 插件官方 API：

- 域名：`ilinkai.weixin.qq.com`（腾讯官方）
- 认证：QR 扫码 → Bearer token
- 收消息：HTTP 长轮询 (35s)
- 发消息：POST + context_token
- **官方通道，不封号**

## License

MIT
