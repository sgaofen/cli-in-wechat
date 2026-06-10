import { log } from './logger.js';

// ─── Resilient fetch ────────────────────────────────────────
//
// issue #18 的根因：对 ilinkai.weixin.qq.com 的请求是裸 fetch，没有超时、
// 没有重试。微信服务器在 TLS 握手/读取阶段偶发 `read ECONNRESET`（常见于代理、
// IPv6、弱网、被中间设备重置），裸 fetch 直接把 TypeError 抛到 main()，启动即崩。
// 这里提供一个统一的带「超时 + 指数退避抖动重试 + 可读诊断」的 fetch 包装，
// 所有出网调用都走它，瞬时网络抖动会被自动重试吞掉，彻底失败时给出可操作的提示。

/** Node/undici error codes that indicate a *transient* network failure worth retrying. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENOTFOUND', // transient DNS hiccup; safe to retry a couple times
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// Only fragments that *specifically* indicate a transient drop. Deliberately NOT
// 'fetch failed' — that is Node's generic wrapper for every network failure, so the
// real signal is the underlying `cause.code` (checked above), not the wrapper text.
const RETRYABLE_MESSAGE_FRAGMENTS = [
  'socket hang up',
  'terminated', // undici: connection closed mid-body
];

export interface FetchRetryOptions extends RequestInit {
  /** Per-attempt timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Additional attempts after the first (total attempts = retries + 1). Default 3. */
  retries?: number;
  /** Base backoff in ms (grows exponentially with jitter). Default 500ms. */
  retryDelayMs?: number;
  /** Upper bound on a single backoff delay. Default 8s. */
  maxRetryDelayMs?: number;
  /** Retry on HTTP 429 / 5xx as well as on network errors. Default false (POSTs are not idempotent). */
  retryOnHttpError?: boolean;
  /** Short label for log lines, e.g. "QR" or "getupdates". */
  label?: string;
}

/** Pull a low-level error code out of a fetch failure by walking the WHOLE cause chain.
 *  Node wraps the real code one level deep (TypeError 'fetch failed' → cause.code), and
 *  fetchWithRetry itself re-wraps once more on exhaustion, so the code can sit at
 *  err.cause.cause.code — a single-level lookup would miss it and silently mis-classify
 *  the exact issue #18 ECONNRESET as non-retryable. */
function errorCode(err: unknown): string | undefined {
  let cur = err as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 6; depth++) {
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}

/** Is this thrown error a transient network failure that a retry might fix? */
export function isRetryableNetworkError(err: unknown): boolean {
  const code = errorCode(err);
  if (code && RETRYABLE_CODES.has(code)) return true;

  const name = (err as { name?: string })?.name;
  // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'.
  if (name === 'TimeoutError') return true;

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RETRYABLE_MESSAGE_FRAGMENTS.some((frag) => msg.includes(frag));
}

/** Walk to the deepest cause's message so the "原始错误" line shows the real low-level
 *  failure ('read ECONNRESET') rather than a re-wrapped friendly string. */
function rootErrorMessage(err: unknown): string {
  let cur = err as { message?: unknown; cause?: unknown } | undefined;
  let msg = err instanceof Error ? err.message : String(err);
  for (let depth = 0; cur && typeof cur === 'object' && cur.cause && depth < 6; depth++) {
    cur = cur.cause as typeof cur;
    if (cur && typeof cur === 'object' && typeof cur.message === 'string' && cur.message) {
      msg = cur.message;
    }
  }
  return msg;
}

/** Turn a low-level network failure into an actionable, human-readable hint. */
export function describeNetworkError(err: unknown): string {
  const code = errorCode(err) || (err as { name?: string })?.name || 'UNKNOWN';
  const base = rootErrorMessage(err);
  const hints: Record<string, string> = {
    ECONNRESET: '连接被重置 (ECONNRESET)。常见原因：代理/VPN、网络不稳定，或被中间设备拦截。可尝试：① 关闭或更换代理/VPN；② 设置 HTTPS_PROXY 环境变量走代理；③ 稍后重试。',
    ETIMEDOUT: '连接超时 (ETIMEDOUT)。请检查网络连通性，或为出网设置 HTTPS_PROXY 代理。',
    UND_ERR_CONNECT_TIMEOUT: '连接超时。请检查网络或代理设置 (HTTPS_PROXY)。',
    ENOTFOUND: 'DNS 解析失败 (ENOTFOUND)。请检查网络/DNS，或确认能访问 ilinkai.weixin.qq.com。',
    EAI_AGAIN: 'DNS 暂时不可用 (EAI_AGAIN)。请检查网络/DNS 设置。',
    ECONNREFUSED: '连接被拒绝 (ECONNREFUSED)。目标端口不可达，检查代理或网络策略。',
    TimeoutError: '请求超时。网络较慢或被阻断，可设置 HTTPS_PROXY 代理后重试。',
  };
  const hint = hints[code];
  return hint ? `${hint}\n(原始错误: ${base})` : `网络请求失败 (${code}): ${base}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Backoff with full jitter, capped. */
function backoffDelay(attempt: number, base: number, max: number): number {
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

/** Wrap a failed-fetch error with a friendly message while preserving the original as
 *  `cause` AND surfacing the low-level code at depth 0, so downstream classifiers work
 *  even though we re-wrap. */
function wrapNetworkError(err: unknown): Error {
  const wrapped = new Error(describeNetworkError(err), { cause: err });
  const code = errorCode(err);
  if (code) (wrapped as { code?: string }).code = code;
  return wrapped;
}

/** Combine an external abort signal with a per-attempt timeout. Uses AbortSignal.any when
 *  available (Node 20.3+/19.7+) and falls back to manual forwarding on older runtimes so
 *  the bridge still works on the declared minimum Node (>=18). */
function combineSignals(external: AbortSignal | undefined | null, timeout: AbortSignal): AbortSignal {
  if (!external) return timeout;
  const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([external, timeout]);
  const controller = new AbortController();
  const forward = (s: AbortSignal) => { if (!controller.signal.aborted) controller.abort(s.reason); };
  for (const s of [external, timeout]) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => forward(s), { once: true });
  }
  return controller.signal;
}

/**
 * fetch() with per-attempt timeout, transient-error retry (exponential backoff + jitter),
 * cooperative external abort, and actionable diagnostics. Drop-in replacement for fetch().
 */
export async function fetchWithRetry(
  url: string,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    retries = 3,
    retryDelayMs = 500,
    maxRetryDelayMs = 8_000,
    retryOnHttpError = false,
    label,
    signal: externalSignal,
    ...init
  } = options;

  const tag = label ? `[http:${label}]` : '[http]';
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Respect a caller-driven abort (shutdown, /cancel) before spending another attempt.
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new DOMException('Aborted', 'AbortError');
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = combineSignals(externalSignal, timeoutSignal);

    try {
      const res = await fetch(url, { ...init, signal });

      // Optionally retry server-side hiccups for idempotent calls.
      if (retryOnHttpError && (res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(maxRetryDelayMs, retryAfter * 1000)
          : backoffDelay(attempt, retryDelayMs, maxRetryDelayMs);
        log.warn(`${tag} HTTP ${res.status}，${delay}ms 后重试 (${attempt + 1}/${retries})`);
        await sleep(delay);
        continue;
      }

      return res;
    } catch (err) {
      lastErr = err;

      // An external abort (not our timeout) is intentional — never retry it.
      if (externalSignal?.aborted) {
        throw externalSignal.reason instanceof Error
          ? externalSignal.reason
          : new DOMException('Aborted', 'AbortError');
      }

      const retryable = isRetryableNetworkError(err);
      if (!retryable || attempt === retries) {
        // Out of attempts (or non-retryable): surface a clear, actionable error.
        if (retryable) {
          log.warn(`${tag} 已重试 ${retries} 次仍失败`);
        }
        throw wrapNetworkError(err);
      }

      const delay = backoffDelay(attempt, retryDelayMs, maxRetryDelayMs);
      const code = errorCode(err) || (err as { name?: string })?.name || 'error';
      log.warn(`${tag} ${code}，${delay}ms 后重试 (${attempt + 1}/${retries})`);
      await sleep(delay);
    }
  }

  // Unreachable, but keeps the type checker happy.
  throw wrapNetworkError(lastErr);
}

// ─── Proxy support (opt-in, lazy) ───────────────────────────
//
// Node 的全局 fetch 默认不走 HTTP(S)_PROXY 环境变量。很多大陆用户需要代理才能稳定
// 访问微信接口。若检测到代理环境变量，尝试用 undici 的 ProxyAgent 设置全局 dispatcher。
// undici 是可选依赖：未安装时给出一次性提示而不是崩溃。

let proxyInitialized = false;

export async function initProxyFromEnv(): Promise<void> {
  if (proxyInitialized) return;
  proxyInitialized = true;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  if (!proxyUrl) return;

  try {
    // Non-literal specifier: undici is an *optional* dependency, so we must not let
    // the type checker hard-require it. Resolved at runtime only when a proxy is set.
    const specifier = 'undici';
    const undici = (await import(specifier)) as {
      ProxyAgent: new (url: string) => unknown;
      setGlobalDispatcher: (d: unknown) => void;
    };
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
    log.info(`已启用代理: ${redactProxy(proxyUrl)}`);
  } catch {
    log.warn(
      `检测到代理环境变量但未安装 undici，代理未生效。如需通过代理访问微信，请运行: npm i undici`,
    );
  }
}

function redactProxy(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}
