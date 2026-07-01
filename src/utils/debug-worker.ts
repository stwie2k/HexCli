import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export const DEBUG_DIR = path.join(os.homedir(), '.hexcli');
export const DEBUG_INFO_FILE = path.join(DEBUG_DIR, 'debug.json');
export const DEBUG_LOG_DIR = path.join(DEBUG_DIR, 'debug');
export const DEBUG_LOCK_FILE = path.join(DEBUG_DIR, 'debug.lock');

/**
 * 按 deviceId 分桶的日志文件路径：~/.hexcli/debug/<deviceId>.log
 * 多设备时不同设备的 debug 流互不干扰，便于回看。
 */
export function getDebugLogFile(deviceId: string): string {
  // 文件名安全化：仅保留字母/数字/横线/下划线
  const safe = deviceId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(DEBUG_LOG_DIR, `${safe}.log`);
}

export interface DebugWorkerInfo {
  pid: number;
  scriptPath: string;
  type?: string;
  deviceId?: string;
  startedAt: string;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 通过 ps 校验目标 PID 仍然是 debug worker，防止 PID 被回收后误杀无关进程。
 * 校验逻辑：命令行需同时包含 `--script-worker` 和当时记录的 scriptPath。
 */
export function verifyWorkerProcess(pid: number, scriptPath: string): boolean {
  if (!isProcessAlive(pid)) return false;
  try {
    const out = execSync(`ps -ww -p ${pid} -o command=`, {
      encoding: 'utf-8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return false;
    return out.includes('--script-worker') && out.includes(scriptPath);
  } catch {
    return false;
  }
}

/**
 * 轮询等待 PID 退出。
 */
export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export function readDebugWorker(): DebugWorkerInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(DEBUG_INFO_FILE, 'utf-8')) as DebugWorkerInfo;
    return Number.isFinite(info?.pid) && info.pid > 0 ? info : null;
  } catch {
    return null;
  }
}

export function writeDebugWorker(info: DebugWorkerInfo): void {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(DEBUG_INFO_FILE, JSON.stringify(info, null, 2));
}

export function removeDebugWorker(): void {
  try {
    fs.unlinkSync(DEBUG_INFO_FILE);
  } catch {
    // ignore
  }
}

/**
 * 父进程启动锁：O_EXCL 创建 ~/.hexcli/debug.lock，写入持有者 PID。
 * 锁仅在 `read → stop-old → spawn → write` 这段临界区内持有。
 * 持有者已死则视为 stale，自动抢占。
 */
export function tryAcquireLaunchLock():
  | { ok: true }
  | { ok: false; holderPid: number | null } {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  try {
    // 原子写入：O_EXCL|O_CREAT 创建并写 PID，一次系统调用之内文件已带内容
    fs.writeFileSync(DEBUG_LOCK_FILE, String(process.pid), { flag: 'wx' });
    return { ok: true };
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
    let holderPid: number | null = null;
    let holderRaw = '';
    try {
      holderRaw = fs.readFileSync(DEBUG_LOCK_FILE, 'utf-8').trim();
      const v = Number(holderRaw);
      if (Number.isFinite(v) && v > 0) holderPid = v;
    } catch {
      // ignore
    }
    // 文件存在但内容为空：可能是另一持有者正在写入间隙（不应发生，因为已改为原子写入；
    // 但保留兜底）。短暂等待一次后再做判断。
    if (!holderRaw) {
      const start = Date.now();
      while (Date.now() - start < 100) {
        try {
          const v = Number(fs.readFileSync(DEBUG_LOCK_FILE, 'utf-8').trim());
          if (Number.isFinite(v) && v > 0) {
            holderPid = v;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
    if (holderPid && isProcessAlive(holderPid)) {
      return { ok: false, holderPid };
    }
    // 持有者已死或文件残留，强抢
    try {
      fs.unlinkSync(DEBUG_LOCK_FILE);
    } catch {
      // ignore
    }
    return tryAcquireLaunchLock();
  }
}

export function releaseLaunchLock(): void {
  try {
    fs.unlinkSync(DEBUG_LOCK_FILE);
  } catch {
    // ignore
  }
}

export type StopResult =
  | { status: 'not-running' }
  | { status: 'stale'; pid: number }
  | { status: 'stopped'; pid: number; forced: boolean }
  | { status: 'failed'; pid: number };

/**
 * 停止 debug worker (SIGTERM → 1.5s 等待 → SIGKILL 兜底)。
 * 调用方不需要先校验 PID 文件是否存在。
 * 通过 ps 校验进程身份，避免误杀 PID 复用后的无关进程。
 */
export async function stopDebugWorker(): Promise<StopResult> {
  const info = readDebugWorker();
  if (!info) return { status: 'not-running' };

  const { pid, scriptPath } = info;

  // 进程不存在 or PID 已被回收给无关进程 → 视为 stale
  if (!verifyWorkerProcess(pid, scriptPath)) {
    removeDebugWorker();
    return { status: 'stale', pid };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removeDebugWorker();
    return { status: 'stopped', pid, forced: false };
  }

  if (await waitForPidExit(pid, 1500)) {
    removeDebugWorker();
    return { status: 'stopped', pid, forced: false };
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ignore
  }
  if (await waitForPidExit(pid, 1000)) {
    removeDebugWorker();
    return { status: 'stopped', pid, forced: true };
  }

  return { status: 'failed', pid };
}
