# cli-in-wechat 开发指南

本文面向维护者，描述当前主线的开发、测试和审查约定。用户安装与微信端命令请看
`README.md`。

## 环境与安装

- Node.js >= 20
- npm（使用仓库中的 `package-lock.json`）
- TypeScript 5.9
- 测试框架：Node.js test runner，通过 `tsx` 加载 TypeScript

首次安装或需要严格复现锁文件时运行：

```bash
npm ci
```

常用脚本：

```bash
npm run dev          # 开发模式，可能进入扫码登录和长轮询
npm run dev:debug    # 开发模式并启用调试日志
npm test             # 直接测试 src，不要求先构建
npm run typecheck    # 类型检查，不生成文件
npm run build        # 编译到 dist
```

`npm test` 实际运行：

```bash
node --import tsx --test test/*.test.ts
```

测试从 `../src/.../*.js` 导入是有意设计。仓库使用 ESM 和 Node16 模块解析，源代码虽是
`.ts`，导入仍写 `.js` 后缀，并由 `tsx` 在测试时解析。不要把单元测试改成从 `dist`
导入；否则测试可能命中旧构建产物，无法证明当前源码正确。

单独运行一个测试文件：

```bash
node --import tsx --test test/router.test.ts
```

## 完整验证

提交前分别运行并检查每条命令的退出码：

```bash
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

这些检查相互独立：测试成功不代表类型检查或构建成功，构建成功也不能替代测试。

PowerShell 7 支持 `&&`，可用于 fail-fast 串联命令；Windows PowerShell 5.1 不支持
`&&`。为了兼容两个版本，文档和排障记录应优先逐条运行命令。不要用 `;` 假装
fail-fast，因为它会在前一条命令失败后继续执行。

## 测试原则

- 测试当前源码和可观察行为，不测试陈旧的 `dist` 输出。
- 单元测试必须隔离真实微信 API、用户凭据和本机 CLI。优先测试纯函数，或注入/替换
  边界依赖。
- 不要用 `try/catch`、提前 `return` 或“依赖不存在就算通过”静默吞掉失败。
- 需要真实 CLI、网络或设备的检查应明确标为 opt-in integration/device test，并与默认
  单元测试分开；缺少前置条件应报告为显式 skip，而不是伪装成 pass。
- 临时文件使用系统临时目录和唯一子目录；测试结束后清理，不读写真实
  `~/.wx-ai-bridge` 数据。
- Windows 与 POSIX 行为不同时，用 Node test runner 的显式 `skip` 条件标注平台限制。

## 项目结构

```text
src/
├── index.ts                  # 入口、登录、单实例和组件装配
├── config.ts                 # 配置、数据路径和原子文件写入
├── adapters/
│   ├── base.ts               # 适配器接口、进程/UTF-8/媒体公共 helper
│   ├── claude.ts             # Claude Agent SDK，失败时回退 CLI
│   ├── codex.ts              # Codex CLI
│   ├── gemini.ts             # Gemini CLI
│   ├── kimi.ts               # Kimi CLI
│   ├── opencode.ts           # OpenCode CLI、模型解析
│   └── registry.ts           # 适配器注册与可用性检测
├── bridge/
│   ├── router.ts             # 消息路由、斜杠命令、任务执行和文件发送
│   ├── session.ts            # 用户设置和会话 ID 持久化
│   └── formatter.ts          # 最终响应格式化
├── cli/
│   └── send.ts               # wcli send 本地控制入口
├── ilink/
│   ├── auth.ts               # QR 登录
│   ├── client.ts             # 长轮询、收发、恢复编排
│   ├── delivery-planner.ts   # 每个入站窗口的发送计划
│   ├── outbox.ts             # 持久化 FIFO 发件箱及迁移
│   ├── quota.ts              # 按账户/用户持久化窗口配额
│   ├── diagnostics.ts        # 脱敏交付诊断
│   ├── send-result.ts        # API 结果和失败分类
│   ├── text-chunk.ts         # UTF-8 字节安全切分
│   └── types.ts              # iLink 协议类型
└── utils/
    ├── crypto.ts             # 媒体加解密
    ├── http.ts               # 超时、重试和代理支持
    ├── media.ts              # 媒体下载、解密启发式和安全文件名
    ├── single-instance.ts    # 单实例锁和本地控制端点
    └── logger.ts             # 日志

test/                         # 与 src 模块对应的单元/回归测试
```

`dist/` 是构建产物，不应手工编辑或作为源码测试入口。

## 适配器约定

所有适配器实现 `src/adapters/base.ts` 的 `CLIAdapter`，并通过 `registry.ts` 注册。新增或
修改适配器时至少核对：

- 参数是否与当前 CLI 版本一致。
- prompt 是否通过 stdin 或安全 argv 传递，避免 shell 解释用户文本。
- abort、timeout、UTF-8 分块输出和 session-expired 语义是否保留。
- 媒体 prompt 是否使用共享 `buildMediaPrompt`。
- capability 声明与实际 streaming、resume、model 等行为是否一致。
- 对应的纯解析逻辑和失败路径是否有测试。

`spawnCli()` 在 Windows 上先解析 npm `.cmd` shim 指向的 Node 脚本或真实可执行文件，
然后以 `shell:false`、逐字 argv 启动。只有无法安全解析时才回退旧的 `shell:true` 路径。
任何含自由文本的适配器都应优先使用 `spawnCli()`；不要直接拼接 shell 命令。

OpenCode 的裸模型名解析由 `resolveBareModelFromList()` 负责；不要在 router 中复制模型
匹配逻辑。Claude 主路径使用 Agent SDK，CLI 是运行时回退路径，两条路径都需要保留
取消、超时和响应格式语义。

## 新增微信命令

1. 在 `src/bridge/router.ts` 的 `handleSlash()` 中添加命令和必要别名。
2. 在同一方法的 `help` 输出中补充简短说明。
3. 明确该命令修改的是持久化 session setting、运行时状态，还是只读信息。
4. 在 `test/router.test.ts` 中通过 mock router 依赖验证回复和状态变化。
5. 若命令触发交付，补充配额、持久化失败和重复发送相关回归测试。
6. 运行“完整验证”中的全部命令。

工具提及的固定别名为：

```typescript
const TOOL_ALIASES = {
  claude: 'claude', cc: 'claude',
  codex: 'codex', cx: 'codex',
  gemini: 'gemini', gm: 'gemini',
  kimi: 'kimi', km: 'kimi',
  opencode: 'opencode', oc: 'opencode',
};
```

修改别名时同步核对普通消息、引用消息、链式调用、帮助文本和测试。

## Durable Delivery 不变量

交付链路不是普通的 `sendText()` 包装。修改 `client.ts`、`outbox.ts`、`quota.ts`、
`delivery-planner.ts`、`router.ts` 或相关持久化格式时，必须保持：

- iLink 入站可能重复；相同账户、用户和消息不能重复执行 Agent 任务。
- poll cursor 只能在整个入站批次处理成功后提交；处理中断的消息必须可重放。
- 待发消息先持久化，再发送；重启后保持 FIFO、优先级、generation、stable item ID 和
  frozen client ID。
- 传输失败不等于确定未送达。模糊结果保持可恢复状态，不能立即生成新的 client ID
  重发。
- 已确认送达但本地 ack/配额写入失败时，不得向用户再发一个误导性的失败气泡。
- 每个新入站消息只开启一个配额窗口；poll replay、重试和 token 变化不能额外增加预算。
- activity、intermediate 和 final 的相对顺序不能跨重启或窗口迁移被打乱；final 不得被
  容量压力静默丢弃。
- 文本按 UTF-8 字节限制切分，不能切坏多字节字符；continuation notice 也计入上限。
- 永久失败只能隔离目标消息，不能阻塞后续 FIFO 项；恢复操作必须保留原身份和 payload。

对应修改至少运行 `delivery-planner`、`outbox`、`quota`、`client-send`、`router` 和
`diagnostics` 测试；默认的 `npm test` 会覆盖全部这些文件。

## 安全不变量

- 默认访问范围是扫码认证的 owner。只有显式 `allowAllUsers: true` 才允许公共访问；不要
  用空 allowlist 推导“允许所有人”。
- 持久化的 `DeliveryDiagnostics` 在写入前必须通过 `redactDiagnostic()` 脱敏；这项保证
  不覆盖普通调试日志。调试日志可能包含 prompt 片段、消息正文或 URL，属于敏感数据，
  不得提交或分享。
- `~/.wx-ai-bridge` 中的凭据、`context_tokens.json`、session、outbox、quota、cursor 和
  diagnostics 是运行时私有数据，不得提交、复制进 fixture 或在错误信息中完整输出。
- 单实例所有权由操作系统 pipe/socket 端点仲裁，而不是仅凭 PID 或 lock 文件判断；第二个
  owner 必须被拒绝，过期 lock 即使记录了仍存活的无关 PID，也不能阻止新实例取得所有权。
- `wcli send` 必须委托给已运行的 bridge；若启动竞争中获取所有权失败，必须重试向现有
  bridge 发起请求。
- `release()` 只有在 lock 中的 `instanceId` 仍属于当前实例时才能删除该 lock。
- 收到的文件名必须经过安全化，禁止路径穿越、隐藏文件和控制字符。图片的直接 URL
  下载路径会按安全文件名保存响应字节，不做 magic-byte 校验；CDN/AES 路径只用已知
  magic bytes 启发式判断响应是否已经是明文，以及 AES-ECB 解密结果是否可识别。这不是
  对所有媒体格式的严格验证：未知格式、缺少密钥或解密失败时，当前实现仍会保存原始
  字节，并可能得到无法查看的文件。
- 入站媒体最初保存在 `~/.wx-ai-bridge/media`；适配器为目标工作目录构造 prompt 时，还
  可能复制到 `<workDir>/.wx-media`。`cleanupMedia()` 当前没有调用方，两个位置都没有自动
  清理保证。任意目标仓库不一定忽略 `.wx-media`；使用者应在目标仓库的 ignore 规则中
  加入 `.wx-media/`，并在提交前检查，避免把收到的媒体或副本提交进版本库。
- 不得把用户 prompt 拼进 shell 命令；新增进程调用必须覆盖 Windows 特殊字符场景。
- 原子写入是持久化恢复策略的一部分，不要用普通覆盖写替代。outbox 对 schema-two 记录的
  stable ID、text payload type 和 delivery state 等关键不变量执行严格拒绝，同时会归一化 sequence、
  时间戳及部分元数据字段或为其提供默认值，并可从备份选择快照；quota、session、config
  和 context-token 等其他 store 对损坏或缺字段数据采用不同程度的宽松忽略、默认值或
  fresh-state 回退。修改
  持久化格式时必须按具体 store 保留并测试其真实恢复语义，不能笼统假设都有严格 schema
  拒绝或备份恢复。

修改上述行为时至少运行：

```bash
node --import tsx --test test/single-instance.test.ts test/send.test.ts test/diagnostics.test.ts
```

## 变更边界

- 保持改动聚焦，不提交 `dist/`、运行时数据、个人编辑器配置或真实诊断日志。
- 协议、持久化 schema 或 CLI 参数变更应更新测试和用户文档。
- 真实设备验证不能替代自动测试；涉及 iLink 限流、恢复或媒体时，在自动测试通过后再做
  独立、脱敏的设备验证。
- 测试输出中的预期错误日志不代表失败；以 Node test runner 的最终 pass/fail 统计和
  进程退出码为准。
