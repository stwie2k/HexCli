import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * HexCli 统一日志工具。
 * 行为：
 *  - 控制台：保留原有彩色 prefix（✔ ℹ ⚠ ✖），用户体验不变。
 *  - 文件：所有调用同时落到 ~/.hex-cli/logs/YYYY-MM-DD.log（按天）。
 *  - 错误另写一份 ~/.hex-cli/logs/YYYY-MM-DD.error.log，方便快速排查。
 *  - 级别：DEBUG / INFO / WARN / ERROR。debug 默认只写文件，
 *    设 HEX_DEBUG=1 时同步打到控制台。
 *  - 保留：启动时清理 7 天前的 .log 文件。
 *  - 写入失败永不抛错（不能因为日志故障让命令失败）。
 *
 * 多进程安全：单行 < PIPE_BUF (4KB) 的 appendFileSync 在 POSIX 上是原子的，
 * 多个 hex 进程同时写同一文件不会撕裂。
 */

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

const HEX_CLI_DIR = path.join(os.homedir(), '.hex-cli');
const LOG_DIR = path.join(HEX_CLI_DIR, 'logs');
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

let _command = 'cli';
let _initialized = false;
let _logFile = '';
let _errFile = '';
let _currentDay = '';
let _startTs = 0;

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

function dateStr(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // 目录创建失败 → 后续 append 也会失败，整体降级为静默
  }
}

/**
 * 删除 7 天前的旧日志。失败不影响命令执行。
 */
function cleanupOldLogs(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - RETENTION_MS;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.log')) continue;
      const fp = path.join(LOG_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(fp);
        }
      } catch {
        // 单个文件失败跳过
      }
    }
  } catch {
    // 整体失败静默
  }
}

function resolveFiles(): void {
  const day = dateStr();
  _currentDay = day;
  _logFile = path.join(LOG_DIR, `${day}.log`);
  _errFile = path.join(LOG_DIR, `${day}.error.log`);
}

/**
 * 在命令真正开始执行前调用一次。
 * - 设置当前命令名（写入每行日志便于过滤）
 * - 创建日志目录、清理过期日志
 * - 写入命令入口标记（argv / cwd / pid / version）
 *
 * 重复调用幂等。如需后续修正命令名（例如子命令路径），使用 setCommand。
 */
export function initLogger(command: string, version?: string): void {
  if (_initialized) return;
  _initialized = true;
  _command = command || 'cli';
  _startTs = Date.now();
  ensureLogDir();
  cleanupOldLogs();
  resolveFiles();

  const argv = process.argv.slice(2).join(' ');
  writeLine(
    'INFO',
    `===== START hex ${argv} | pid=${process.pid} | node=${process.version} | ` +
      `cli=${version || 'unknown'} | cwd=${process.cwd()} =====`,
  );
}

/**
 * 修改当前命令名，仅影响后续日志行的 [command] 标签。
 * 用于 preAction 中拿到真实子命令路径后覆写入口默认的 'cli'。
 */
export function setCommand(name: string): void {
  if (name) _command = name;
}

/**
 * 命令结束时调用（注册到 process.on('exit')）。
 * 同步操作，可在 exit 钩子里安全使用。
 */
export function finalize(exitCode?: number): void {
  if (!_initialized) return;
  const dur = Date.now() - _startTs;
  writeLine('INFO', `===== END exitCode=${exitCode ?? 0} duration=${dur}ms =====`);
}

function writeLine(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  // 未初始化时也要兑底写（防止某些路径在 initLogger 之前 logger.error）
  if (!_logFile) {
    ensureLogDir();
    resolveFiles();
  } else {
    // 跨天检测：长期进程（如 daemon）跨过 0 点后需切换到新一天的日志文件
    const today = dateStr();
    if (today !== _currentDay) {
      resolveFiles();
    }
  }
  const ts = new Date().toISOString();
  // 单行格式：时间 [级别] [pid] [command] message
  const line = `${ts} [${level.padEnd(5)}] [pid=${process.pid}] [${_command}] ${msg}\n`;
  try {
    fs.appendFileSync(_logFile, line);
  } catch {
    // 写日志失败不抛错
  }
  if (level === 'ERROR') {
    try {
      fs.appendFileSync(_errFile, line);
    } catch {
      // ignore
    }
  }
}

/**
 * DEBUG：默认只写文件。
 * 设环境变量 HEX_DEBUG=1 同步打印到控制台（方便临时排查）。
 */
export function debug(message: string): void {
  writeLine('DEBUG', message);
  if (process.env.HEX_DEBUG) {
    console.log(`${GRAY}🔍 ${message}${RESET}`);
  }
}

export function success(message: string): void {
  console.log(`${GREEN}✔ ${message}${RESET}`);
  writeLine('INFO', `✔ ${message}`);
}

export function error(message: string): void {
  console.error(`${RED}✖ ${message}${RESET}`);
  writeLine('ERROR', message);
}

export function info(message: string): void {
  console.log(`${BLUE}ℹ ${message}${RESET}`);
  writeLine('INFO', message);
}

export function warn(message: string): void {
  console.warn(`${YELLOW}⚠ ${message}${RESET}`);
  writeLine('WARN', message);
}

export function json(data: any): void {
  const text = JSON.stringify(data, null, 2);
  console.log(text);
  // 文件单行存储，方便 grep
  try {
    writeLine('DEBUG', `json: ${JSON.stringify(data)}`);
  } catch {
    writeLine('DEBUG', 'json: <stringify failed>');
  }
}

/**
 * 获取当前日志文件路径，方便 doctor 子命令引用。
 */
export function getLogFile(): string {
  if (!_logFile) resolveFiles();
  return _logFile;
}

export function getLogDir(): string {
  return LOG_DIR;
}

export const logger = { success, error, info, warn, json, debug };
