import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 默认设备会话存储：`~/.hexcli/session.json`
 *
 * 仅记录显式来源（hex device use）写入的默认设备。
 * 过期策略：超过 7 天未在 daemon /devices 出现自动失效。
 */

const SESSION_DIR = path.join(os.homedir(), '.hexcli');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

/** 默认 7 天过期 */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionData {
  defaultDeviceId: string;
  defaultDeviceLabel?: string;
  rememberedAt: number;
  rememberedBy: 'explicit';
}

export function getSessionFilePath(): string {
  return SESSION_FILE;
}

export function readSession(): SessionData | null {
  try {
    const content = fs.readFileSync(SESSION_FILE, 'utf-8');
    const parsed = JSON.parse(content) as SessionData;
    if (!parsed.defaultDeviceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 原子写入：先写 .tmp 再 rename。
 */
export function writeSession(data: SessionData): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
  const tmp = SESSION_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, SESSION_FILE);
}

export function clearSession(): void {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    // 文件不存在时忽略
  }
}

/**
 * 判断 session 是否已过期（默认 7 天）。
 */
export function isSessionExpired(data: SessionData, ttlMs: number = DEFAULT_TTL_MS): boolean {
  return Date.now() - data.rememberedAt > ttlMs;
}
