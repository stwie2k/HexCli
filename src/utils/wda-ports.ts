/**
 * WDA 多设备本机端口分配。
 *
 * 模型：每个 iOS 设备独占一个本机端口（首台 8100、第二台 8101...），
 *      iproxy 把该本机端口转发到设备端 8100（设备端写死，所有 iOS WDA 都监听 8100）。
 *
 * 持久化：~/.hex-cli/wda-ports.json，结构 { "<udid>": <port> }。
 * 互斥：mkdir 风格的轻量目录锁 ~/.hex-cli/wda-ports.lock，重试 5s。
 *
 * 使用：
 *   - getPortForUdid(udid)：拿端口，必要时分配并写入。常态走内存缓存。
 *   - getMappedPortForUdid(udid)：仅查不分配，未分配时返回 null。供"是否运行中"等只读判断使用。
 *   - releasePortForUdid(udid)：从映射中移除（reset 单设备时用）。
 *   - clearAllPorts()：清空整个映射（reset --all 用）。
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import * as logger from './logger.js';

const HEX_CLI_DIR = path.join(os.homedir(), '.hex-cli');
const PORTS_FILE = path.join(HEX_CLI_DIR, 'wda-ports.json');
const LOCK_DIR = path.join(HEX_CLI_DIR, 'wda-ports.lock');

export const BASE_PORT = 8100;
export const MAX_PORT = 8199;

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5000;
// 锁目录"过期"判定：超过该时长视为上次进程崩溃残留，可强制清除
const STALE_LOCK_MS = 30 * 1000;

interface PortMap {
  [udid: string]: number;
}

// 进程内缓存：避免 hot path（每次 wdaRequest）反复读文件 / 加锁
const _cache: Map<string, number> = new Map();

function ensureHexCliDir(): void {
  if (!fs.existsSync(HEX_CLI_DIR)) {
    fs.mkdirSync(HEX_CLI_DIR, { recursive: true });
  }
}

function readPortMap(): PortMap {
  try {
    if (!fs.existsSync(PORTS_FILE)) return {};
    const raw = fs.readFileSync(PORTS_FILE, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PortMap;
    }
    return {};
  } catch (err: any) {
    logger.warn(`wda-ports.json 解析失败，将重置：${err.message}`);
    return {};
  }
}

function writePortMap(map: PortMap): void {
  ensureHexCliDir();
  fs.writeFileSync(PORTS_FILE, JSON.stringify(map, null, 2));
}

/**
 * 探测本机端口是否空闲（127.0.0.1 上能否 listen）。
 * 不绑 0.0.0.0 是为了避免误报"全网占用"（实际只关心 iproxy 用的本机回环）。
 */
function isPortFreeOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 用目录互斥获取文件锁。
 * 锁存在且 mtime 超过 STALE_LOCK_MS 视为崩溃残留，强行清掉再重试。
 */
async function acquireLock(): Promise<void> {
  ensureHexCliDir();
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try {
            fs.rmdirSync(LOCK_DIR);
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(
          `获取 wda-ports.json 文件锁超时（${LOCK_TIMEOUT_MS}ms）。` +
            `如果是异常残留：rm -rf ${LOCK_DIR}`,
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

function releaseLock(): void {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    // 已被释放或残留清理，忽略
  }
}

async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

/**
 * 在 [BASE_PORT, MAX_PORT] 区间内寻找首个未被 portMap 占用、且本机回环空闲的端口。
 * 找不到抛出明确错误。
 */
async function findFreePort(taken: Set<number>): Promise<number> {
  for (let p = BASE_PORT; p <= MAX_PORT; p++) {
    if (taken.has(p)) continue;
    if (await isPortFreeOnLoopback(p)) {
      return p;
    }
  }
  throw new Error(
    `WDA 本机端口区间 ${BASE_PORT}-${MAX_PORT} 已全部占用，无法为新设备分配端口。` +
      `请执行 hex tap reset --all 或手动清理后重试。`,
  );
}

/**
 * 拿到 udid 对应的本机端口；不存在则在锁内分配并持久化。
 */
export async function getPortForUdid(udid: string): Promise<number> {
  const cached = _cache.get(udid);
  if (cached !== undefined) return cached;

  return withLock(async () => {
    const map = readPortMap();
    const existing = map[udid];
    if (existing) {
      // 已分配：无论端口当前空闲还是被 iproxy 占着，都复用。
      // 不可能被无关的进程占用（包含贼走）——贼走场景是边界 case，由调用方遇到 iproxy
      // 启动失败时手动 reset 重新分配，不该在这里隐式换口。
      _cache.set(udid, existing);
      return existing;
    }
    // 未分配：找空闲端口写入
    const taken = new Set<number>(Object.values(map));
    const port = await findFreePort(taken);
    map[udid] = port;
    writePortMap(map);
    _cache.set(udid, port);
    logger.debug(`wda-ports: 新分配 udid=${udid} port=${port}`);
    return port;
  });
}

/**
 * 仅查询，不分配。常用于"判断 iproxy 是否在为 udid 转发"等只读路径。
 */
export function getMappedPortForUdid(udid: string): number | null {
  const cached = _cache.get(udid);
  if (cached !== undefined) return cached;
  // 读文件无需锁：读到撕裂或旧版仅意味着判定结果保守，外层会兜底
  const map = readPortMap();
  const p = map[udid];
  if (typeof p === 'number') {
    _cache.set(udid, p);
    return p;
  }
  return null;
}

/**
 * 移除 udid 的端口映射（reset 单设备时用）。
 * 不影响其它 udid。
 */
export async function releasePortForUdid(udid: string): Promise<void> {
  _cache.delete(udid);
  await withLock(async () => {
    const map = readPortMap();
    if (map[udid] !== undefined) {
      delete map[udid];
      writePortMap(map);
    }
  });
}

/**
 * 清空整个端口映射（reset --all 用）。
 */
export async function clearAllPorts(): Promise<void> {
  _cache.clear();
  await withLock(async () => {
    writePortMap({});
  });
}

/**
 * 列出所有已分配映射的快照（reset --all 时用于确定要 kill 的 iproxy 端口集合）。
 * 同步读，不加锁；并发期间结果可能略旧但不影响清理逻辑。
 */
export function snapshotPortMap(): PortMap {
  return readPortMap();
}
