import http from 'http';
import { getMappedPortForUdid } from './wda-ports.js';

export interface WDAResponse {
  value: any;
  sessionId?: string;
  status?: number;
}

export const WDA_HOST = '127.0.0.1';

/**
 * 未为 udid 分配本机端口时 wdaRequest 抛出的错误。
 * 未分配＝尚未走过 ensureWDA / startIproxyBackgroundAndVerify，探活路径上是预期中的。
 */
export class WDANotAllocatedError extends Error {
  constructor(udid: string) {
    super(`WDA 未为 udid=${udid} 分配本机端口（尚未启动 iproxy 转发）`);
    this.name = 'WDANotAllocatedError';
  }
}

/**
 * WDA HTTP 请求封装（按 udid 寻址本机端口）。
 *
 * 设计关键点：仅使用 getMappedPortForUdid（只读查映射），不会在探活时误分配。
 *   - 未分配 → 抛 WDANotAllocatedError，checkWDA / waitForWDAReady 会 catch 后返回 false。
 *   - 调用方该走 ensureWDA 路径以触发 startIproxyBackgroundAndVerify -> getPortForUdid（写）。
 *
 * iproxy 把每台设备的 8100 转发到本机一个独立端口（见 wda-ports.ts），
 * 因此请求时需要传 udid 才能拿到对应的本机端口。
 */
export async function wdaRequest(
  udid: string,
  method: 'GET' | 'POST' | 'DELETE',
  pathname: string,
  body?: any,
  timeoutMs: number = 5000,
): Promise<WDAResponse> {
  const port = getMappedPortForUdid(udid);
  if (port === null) {
    throw new WDANotAllocatedError(udid);
  }
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        host: WDA_HOST,
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const json = chunks ? JSON.parse(chunks) : {};
            resolve(json);
          } catch (e: any) {
            reject(new Error(`WDA 响应解析失败: ${e.message}, 原始响应: ${chunks}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('WDA 请求超时'));
    });
    req.on('error', (err) => reject(err));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 检查指定 udid 对应的本机 WDA 端口 /status 是否可达且返回有效。
 */
export async function checkWDA(udid: string): Promise<boolean> {
  try {
    const res = await wdaRequest(udid, 'GET', '/status', undefined, 3000);
    return !!res.value;
  } catch {
    return false;
  }
}

/**
 * 轮询等待 WDA /status 就绪
 */
export async function waitForWDAReady(
  udid: string,
  timeoutMs: number = 30000,
  intervalMs: number = 2000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await wdaRequest(udid, 'GET', '/status', undefined, 2000);
      if (res && res.value) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * 获取或创建 WDA session。
 *
 * 处理"死 session"场景：WDA 重启 / app 退后台 / 锁屏后，
 * `/status` 仍可能返回上次的 sessionId，但该 session 在后续调用中会 404。
 * 这里拿到后会主动验证一下，仅在验证通过才复用，否则重建。
 */
export async function getOrCreateSession(udid: string): Promise<string> {
  try {
    const status = await wdaRequest(udid, 'GET', '/status', undefined, 3000);
    const sid = status.sessionId;
    if (sid && (await isSessionAlive(udid, sid))) {
      return sid;
    }
  } catch {}

  const res = await wdaRequest(udid, 'POST', '/session', { capabilities: {} }, 15000);
  const sessionId = res.sessionId || res.value?.sessionId;
  if (!sessionId) {
    throw new Error('创建 WDA session 失败：未返回 sessionId');
  }
  return sessionId;
}

/**
 * 调一个轻量端点验证 session 是否还有效。
 * 选 /window/size：W3C 标准、WDA 实现、负载极小；session 失效时会返回含 error 的 value。
 */
async function isSessionAlive(udid: string, sessionId: string): Promise<boolean> {
  try {
    const res = await wdaRequest(udid, 'GET', `/session/${sessionId}/window/size`, undefined, 3000);
    if (!res || res.value === undefined || res.value === null) return false;
    if (typeof res.value === 'object' && 'error' in (res.value as object)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 通过 WDA 截图，返回 PNG 二进制 Buffer
 * 接口：GET /screenshot 返回 base64 编码的 PNG
 */
export async function captureScreenshot(udid: string, timeoutMs: number = 15000): Promise<Buffer> {
  const res = await wdaRequest(udid, 'GET', '/screenshot', undefined, timeoutMs);
  const b64 = typeof res.value === 'string' ? res.value : '';
  if (!b64) {
    throw new Error('WDA 截图返回为空');
  }
  return Buffer.from(b64, 'base64');
}
