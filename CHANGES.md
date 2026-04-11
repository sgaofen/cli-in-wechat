# 文件传输功能实现

> 本次修改为 cli-in-wechat 添加了完整的文件传输功能，支持在微信和 CLI 工具之间收发文件。

## 功能概述

| 功能 | 说明 |
|------|------|
| 接收文件 | 微信发送的图片/文件/视频自动下载并传给 CLI 处理 |
| 发送文件 | `/send <路径>` 命令发送本地文件到微信 |

## 新增文件

### `src/utils/media.ts`

媒体文件下载工具，核心功能：

```typescript
// 下载媒体文件
downloadMedia(media: CDNMedia, options): Promise<DownloadedMedia>

// 下载图片/文件/视频
downloadImage(item: ImageItem, workDir?): Promise<DownloadedMedia>
downloadFile(item: FileItem, workDir?): Promise<DownloadedMedia>
downloadVideo(item: VideoItem, workDir?): Promise<DownloadedMedia>

// 复制文件到工作目录
copyMediaToWorkDir(media: DownloadedMedia, workDir: string): DownloadedMedia
```

**关键实现细节：**

1. **下载地址**：优先使用 `media.full_url`（微信 CDN 地址），否则用 `encrypt_query_param` 构建
2. **文件解密**：微信 CDN 文件是加密的，需要 AES-128-ECB 解密
3. **工作目录**：文件会复制到 `<workDir>/.wx-media/` 子目录，便于 CLI 工具访问

```
用户工作目录/
└── .wx-media/
    ├── document.pdf
    ├── image.jpg
    └── video.mp4
```

## 修改的文件

### `src/ilink/types.ts`

添加 `full_url` 字段：

```typescript
export interface CDNMedia {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type?: number;
  full_url?: string;  // 新增：微信 CDN 下载地址
}
```

### `src/ilink/client.ts`

**新增方法：**

```typescript
// 发送文件到微信
async sendFile(userId: string, filePath: string, title?: string): Promise<void>
async sendImage(userId: string, imagePath: string, caption?: string): Promise<void>
async sendVideo(userId: string, videoPath: string): Promise<void>

// 上传文件到 CDN
private async uploadToCdn(userId: string, filePath: string, mediaType: number)
```

**文件发送流程：**

```
1. 读取本地文件 → 计算 MD5
2. 生成随机 AES 密钥
3. 调用 ilink/bot/getuploadurl 获取上传参数
4. AES-128-ECB 加密后上传到 novac2c.cdn.weixin.qq.com
5. 获取 downloadParam
6. 调用 ilink/bot/sendmessage 发送文件消息
```

**修改 `parseMessage`：**

- 新增对 `type=2`（图片）、`type=4`（文件）、`type=5`（视频）的处理
- 自动下载并返回 `DownloadedMedia[]`

### `src/bridge/router.ts`

1. **新增 `/send` 命令**（行 560-585）：
   ```
   /send <文件路径>  发送文件到微信
   ```
   自动识别文件类型（图片/视频/普通文件）

2. **修改 `handle` 方法**：处理 `DownloadedMedia[]` 并传递给 CLI

3. **新增 `mediaContext` 构建**：将文件信息注入到 prompt

### `src/adapters/*.ts`（所有适配器）

**新增 `buildMediaPrompt` 函数：**

```typescript
function buildMediaPrompt(prompt: string, media?: DownloadedMedia[], workDir?: string): string
```

生成的提示词格式：

```
已接收到用户通过微信发送的文件：

- 文件名.pdf
  类型: 文件
  大小: 123.4KB
  路径: .wx-media/文件名.pdf

文件已保存到工作目录，等待您的指令。
```

### `src/utils/crypto.ts`

新增函数：

```typescript
// 编码 AES 密钥（hex -> base64）
export function encodeMessageAesKey(aeskey: Buffer): string

// 计算 MD5
export function md5(data: Buffer | string): string
```

## 关键 Bug 修复

### 1. Windows shell 换行符问题

**问题**：`shell: true` 在 Windows 上会把 `\n` 当作字面字符，导致 CLI 收到错误的 prompt。

**解决**：改用 stdin 传递提示词。

```typescript
// 之前（错误）
const args = ['-p', prompt, ...];

// 之后（正确）
const args = [...];
proc.stdin!.write(prompt, 'utf8');
proc.stdin!.end();
```

**影响文件**：`src/adapters/claude.ts`

### 2. 文件解密失败

**问题**：下载的文件无法读取，文件头是乱码。

**原因**：微信 CDN 文件是 AES 加密的，需要解密。

**解决**：尝试 ECB 和 CBC 两种解密方式，检查解密结果是否为有效文件头。

```typescript
function decryptMedia(data: Buffer, aesKeyBase64: string): Buffer {
  // 先尝试 ECB（微信上传用的是 ECB）
  // 检查文件头是否有效（%PDF, PK, PNG 等）
  // 失败则尝试 CBC
}
```

### 3. 文件路径问题

**问题**：文件下载到 `~/.wx-ai-bridge/media/`，但 CLI 工具的工作目录是项目目录，找不到文件。

**解决**：在 `buildMediaPrompt` 中调用 `copyMediaToWorkDir` 复制到工作目录的 `.wx-media/` 子目录。

## 使用方式

### 接收文件

在微信中发送文件，CLI 工具会自动接收：

```
微信发送: document.pdf
CLI 收到提示:
已接收到用户通过微信发送的文件：
- document.pdf
  类型: 文件
  大小: 45.2KB
  路径: .wx-media/document.pdf
文件已保存到工作目录，等待您的指令。
```

### 发送文件

在微信中发送命令：

```
/send C:\Users\xxx\document.pdf    发送文件
/send C:\Users\xxx\photo.jpg       发送图片（自动识别）
/send C:\Users\xxx\video.mp4       发送视频（自动识别）
```

## 依赖说明

- **iLink API 端点**：
  - `ilink/bot/getuploadurl` - 获取上传参数
  - `ilink/bot/sendmessage` - 发送消息
- **微信 CDN**：
  - 上传：`https://novac2c.cdn.weixin.qq.com/c2c/upload`
  - 下载：`full_url` 字段

## 注意事项

1. **文件大小限制**：图片 20MB、文件 50MB、视频 100MB
2. **工作目录**：确保 `/dir` 设置正确，文件会保存到 `<workDir>/.wx-media/`
3. **解密**：所有从微信 CDN 下载的文件都需要 AES 解密
4. **清理**：`.wx-media/` 目录不会自动清理，需要手动删除

## 待测试

- **发送文件到微信**：`/send` 命令的上传功能尚未完整测试
- 需要验证：
  - `ilink/bot/getuploadurl` API 调用是否正确
  - AES-128-ECB 加密上传是否成功
  - 微信端能否正常接收文件
- 如有问题，可参考 https://github.com/UNLINEARITY/CLI-WeChat-Bridge 的实现
