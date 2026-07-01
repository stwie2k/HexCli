import { Command } from 'commander';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ensureConnected, sendToDaemon } from '../daemon/client.js';
import { readDaemonInfo } from '../daemon/server.js';
import { resolveTarget } from '../utils/selector.js';
import * as logger from '../utils/logger.js';
import { buildPayload, loadMockFile, mockFileExists } from '../mock/store.js';
import {
  DEBUG_LOG_DIR,
  getDebugLogFile,
  isProcessAlive,
  readDebugWorker,
  releaseLaunchLock,
  removeDebugWorker,
  stopDebugWorker,
  tryAcquireLaunchLock,
  writeDebugWorker,
} from '../utils/debug-worker.js';

// ANSI 颜色
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';

// Socket command → CLI type
const COMMAND_TYPE_MAP: Record<string, string> = {
  AppLog: 'nav',
  UT: 'ut',
  mtop: 'mtop',
  mtop_ssr: 'mtop-ssr',
};

// CLI type → 终端显示标签
const TYPE_LABEL_MAP: Record<string, string> = {
  nav: 'NAV',
  ut: 'UT',
  mtop: 'MTOP',
  'mtop-ssr': 'MTOP-SSR',
};

// CLI type → 颜色
const TYPE_COLOR_MAP: Record<string, string> = {
  nav: GREEN,
  ut: YELLOW,
  mtop: CYAN,
  'mtop-ssr': MAGENTA,
};

const VALID_TYPES = Object.keys(TYPE_LABEL_MAP);

function getTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatEvent(type: string, data: any): string {
  const time = getTimestamp();
  const color = TYPE_COLOR_MAP[type] || '';
  const label = TYPE_LABEL_MAP[type] || type;
  const prefix = `${DIM}[${time}]${RESET} ${color}[${label}]${RESET}`;

  switch (type) {
    case 'mtop': {
      const apiName = data?.apiName ?? data?.api ?? '-';
      const method = data?.method ?? '-';
      const totalTime = data?.perfData?.totalTime ?? data?.totalTime ?? '-';
      return `${prefix} ${apiName}  ${method}  ${totalTime}ms`;
    }
    case 'mtop-ssr': {
      const apiName = data?.apiName ?? data?.api ?? '-';
      const method = data?.method ?? '-';
      const requestId = data?.requestId ?? '-';
      return `${prefix} ${apiName}  ${method}  requestId:${requestId}`;
    }
    case 'ut': {
      const summary = data?.eventName ?? data?.eventId ?? data?.name ?? JSON.stringify(data).slice(0, 80);
      return `${prefix} ${summary}`;
    }
    case 'nav': {
      const content = typeof data === 'string' ? data : (data?.message ?? data?.log ?? JSON.stringify(data));
      return `${prefix} ${content}`;
    }
    default:
      return `${prefix} ${JSON.stringify(data)}`;
  }
}

function hasDetailedJson(data: any): boolean {
  if (data === null || data === undefined || typeof data !== 'object') return false;
  return Object.keys(data).length > 3;
}

const debug = new Command('debug')
  .description('实时调试 - 监听设备推送的调试数据')
  .option('--type <types>', '监听的数据类型（逗号分隔: nav,ut,mtop,mtop-ssr）')
  .option(
    '--script <path>',
    '指定回调脚本路径。提供后命令立即返回，事件以 `<script> <type> <dataJson>` 形式异步回调',
  )
  .option('--stop', '停止后台 debug worker')
  .option('--status', '查看后台 debug worker 状态')
  .option('--script-worker', '内部参数：worker 模式（请勿直接使用）')
  .option('--udid <udid>', '指定调试目标设备 UDID（多设备必填）')
  .action(async (options: {
    type?: string;
    script?: string;
    stop?: boolean;
    status?: boolean;
    scriptWorker?: boolean;
    udid?: string;
  }) => {
    // --status：查看 worker 状态（不依赖 daemon/设备）
    if (options.status) {
      const info = readDebugWorker();
      if (!info) {
        logger.info('debug worker 未运行');
        process.exit(0);
      }
      if (!isProcessAlive(info.pid)) {
        logger.warn(`PID ${info.pid} 已不存在，清理残留信息`);
        removeDebugWorker();
        process.exit(0);
      }
      logger.success(`debug worker 运行中 (PID ${info.pid})`);
      logger.info(`回调脚本: ${info.scriptPath}`);
      if (info.type) logger.info(`类型过滤: ${info.type}`);
      if (info.deviceId) {
        logger.info(`目标设备: ${info.deviceId}`);
        logger.info(`运行日志: ${getDebugLogFile(info.deviceId)}`);
      } else {
        logger.info(`运行日志目录: ${DEBUG_LOG_DIR}`);
      }
      logger.info(`启动时间: ${info.startedAt}`);
      process.exit(0);
    }

    // --stop：终止 worker（不依赖 daemon/设备）
    if (options.stop) {
      const result = await stopDebugWorker();
      switch (result.status) {
        case 'not-running':
          logger.info('debug worker 未运行');
          break;
        case 'stale':
          logger.warn(`PID ${result.pid} 已不存在，已清理残留信息`);
          break;
        case 'stopped':
          logger.success(
            `debug worker 已停止 (PID ${result.pid})${result.forced ? ' [SIGKILL]' : ''}`,
          );
          break;
        case 'failed':
          logger.error(`无法终止 debug worker (PID ${result.pid})，请手动 kill -9`);
          process.exit(1);
      }
      process.exit(0);
    }

    // 解析 type 过滤器
    let allowedTypes: Set<string> | null = null;
    if (options.type) {
      const types = options.type.split(',').map((t) => t.trim().toLowerCase());
      const invalid = types.filter((t) => !VALID_TYPES.includes(t));
      if (invalid.length > 0) {
        logger.error(`不支持的类型: ${invalid.join(', ')}`);
        logger.info(`支持的类型: ${VALID_TYPES.join(', ')}`);
        process.exit(1);
      }
      allowedTypes = new Set(types);
    }

    // 解析目标设备：多设备无 --udid 时报错列候选
    let targetUdid: string;
    try {
      const target = await resolveTarget({ udid: options.udid });
      targetUdid = target.udid;
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }

    // --script 模式：fork detached worker 后立刻退出
    if (options.script && !options.scriptWorker) {
      const scriptPath = path.resolve(options.script);
      if (!fs.existsSync(scriptPath)) {
        logger.error(`脚本不存在: ${scriptPath}`);
        process.exit(1);
      }
      try {
        fs.accessSync(scriptPath, fs.constants.X_OK);
      } catch {
        logger.error(`脚本不可执行，请先运行: chmod +x ${scriptPath}`);
        process.exit(1);
      }

      // 抢启动锁：防止两个 hex debug --script 并发 fork 出双 worker
      const lock = tryAcquireLaunchLock();
      if (!lock.ok) {
        logger.error(
          `另一个 hex debug 正在启动 worker (PID ${lock.holderPid})，请稍后重试`,
        );
        process.exit(1);
      }
      // 父进程任何路径退出都释放锁
      process.on('exit', releaseLaunchLock);

      // 如有旧 worker，先停掉（保持"最新者可用"语义）
      const existing = readDebugWorker();
      if (existing && isProcessAlive(existing.pid)) {
        logger.info(`检测到旧 debug worker (PID ${existing.pid})，先停止...`);
        const stopResult = await stopDebugWorker();
        if (stopResult.status === 'failed') {
          logger.error(`旧 worker 无法终止 (PID ${stopResult.pid})，请手动 kill -9`);
          process.exit(1);
        }
        if (stopResult.status === 'stopped') {
          logger.info(
            `旧 worker 已停止 (PID ${stopResult.pid})${stopResult.forced ? ' [SIGKILL]' : ''}`,
          );
        }
      } else if (existing) {
        removeDebugWorker();
      }

      const logFile = getDebugLogFile(targetUdid);
      const logDir = path.dirname(logFile);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      // 简易日志轮转：超过 5MB 时归档为 .1（覆盖旧的 .1）
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > 5 * 1024 * 1024) {
          fs.renameSync(logFile, logFile + '.1');
        }
      } catch {
        // 文件不存在，跳过
      }
      const logFd = fs.openSync(logFile, 'a');

      const args = [
        process.argv[1],
        'debug',
        '--script',
        scriptPath,
        '--script-worker',
        '--udid',
        targetUdid,
      ];
      if (options.type) args.push('--type', options.type);

      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      fs.closeSync(logFd);

      if (child.pid) {
        writeDebugWorker({
          pid: child.pid,
          scriptPath,
          type: options.type,
          deviceId: targetUdid,
          startedAt: new Date().toISOString(),
        });
      }

      logger.success(`debug worker 已在后台启动 (PID ${child.pid})`);
      logger.info(`目标设备: ${targetUdid}`);
      logger.info(`回调脚本: ${scriptPath}`);
      logger.info(`运行日志: ${logFile}`);
      logger.info(`查看状态: hex debug --status`);
      logger.info(`停止命令: hex debug --stop`);
      process.exit(0);
    }

    // 确认设备连接（已通过 resolveTarget 校验，再做一次保护）
    try {
      await ensureConnected();
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }

    // 获取 Daemon 信息
    const daemonInfo = readDaemonInfo();
    if (!daemonInfo) {
      logger.error('无法读取 Daemon 信息');
      process.exit(1);
    }

    // 打印启动提示
    console.log('');
    if (options.scriptWorker && options.script) {
      logger.success(
        `debug worker 启动 (PID ${process.pid}) 设备: ${targetUdid} 回调: ${options.script}`,
      );
    } else {
      logger.success(`已连接到设备 ${targetUdid}，正在监听调试数据... (按 Ctrl+C 退出)`);
    }
    if (allowedTypes) {
      logger.info(`过滤类型: ${[...allowedTypes].map((t) => TYPE_LABEL_MAP[t]).join(', ')}`);
    } else {
      logger.info(`监听全部类型: ${VALID_TYPES.map((t) => TYPE_LABEL_MAP[t]).join(', ')}`);
    }
    console.log('');

    // 先建立 SSE 连接，确保不丢失任何推送事件
    let req: http.ClientRequest | null = null;
    let cleaningUp = false;

    // 优雅退出：关闭数据上报 + 断开 SSE。提前声明以便 SSE end/error 也能调用。
    const cleanup = () => {
      if (cleaningUp) return;
      cleaningUp = true;
      if (options.scriptWorker) {
        removeDebugWorker();
      } else {
        console.log('');
        logger.info('停止监听');
      }

      // 通知设备关闭上报（best-effort）
      const disableCommands = [
        { command: 'UT', params: { isOpen: false } },
        { command: 'mtopMock', params: { mtopOpen: false } },
        { command: 'AppLog', params: { isOpen: false } },
      ];
      for (const cmd of disableCommands) {
        sendToDaemon(cmd.command, cmd.params, targetUdid).catch(() => {});
      }

      if (req) {
        req.destroy();
      }
      // 给关闭命令一点时间发出
      setTimeout(() => process.exit(0), 300);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    const connect = (): Promise<void> => {
      return new Promise((resolve) => {
        req = http.request(
          {
            hostname: '127.0.0.1',
            port: daemonInfo.ipcPort,
            path: '/events?udid=' + encodeURIComponent(targetUdid),
            method: 'GET',
            headers: {
              Accept: 'text/event-stream',
              'Cache-Control': 'no-cache',
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              logger.error(`SSE 连接失败，状态码: ${res.statusCode}`);
              process.exit(1);
            }

            let buffer = '';

            res.setEncoding('utf-8');
            res.on('data', (chunk: string) => {
              buffer += chunk;

              // 按 \n\n 分割事件
              const events = buffer.split('\n\n');
              // 最后一段可能不完整，保留在 buffer 中
              buffer = events.pop() || '';

              for (const event of events) {
                if (!event.trim()) continue;

                // 解析 SSE data 行
                const lines = event.split('\n');
                let dataStr = '';
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    dataStr += line.slice(6);
                  } else if (line.startsWith('data:')) {
                    dataStr += line.slice(5);
                  }
                }

                if (!dataStr) continue;

                try {
                  const parsed = JSON.parse(dataStr);

                  // 收到连接确认后，标记 SSE 已就绪
                  if (parsed.type === 'connected') {
                    resolve();
                    continue;
                  }

                  const command = parsed.command;
                  const data = parsed.data;
                  const eventDeviceId = parsed.deviceId ?? targetUdid;

                  if (!command) continue;

                  // 映射 command → type
                  const type = COMMAND_TYPE_MAP[command];
                  if (!type) continue;

                  // 类型过滤
                  if (allowedTypes && !allowedTypes.has(type)) continue;

                  if (options.scriptWorker && options.script) {
                    // worker 模式：异步调用回调脚本
                    // 第三个参数追加 deviceId，方便脚本侧多设备区分
                    const dataJson = JSON.stringify(data ?? {});
                    const proc = spawn(
                      options.script,
                      [type, dataJson, eventDeviceId],
                      {
                        stdio: 'ignore',
                        detached: false,
                      },
                    );
                    proc.on('error', (err) => {
                      console.error(`[${getTimestamp()}] 调用脚本失败: ${err.message}`);
                    });
                    // 注册 exit listener 让 Node/OS 正确回收子进程，避免 zombie 累积
                    proc.on('exit', () => {});
                  } else {
                    // 前台模式：格式化输出到终端
                    const formatted = formatEvent(type, data);
                    console.log(formatted);

                    // 详细 JSON 追加输出
                    if (hasDetailedJson(data)) {
                      const jsonStr = JSON.stringify(data, null, 2);
                      const indented = jsonStr
                        .split('\n')
                        .map((line) => `  ${DIM}${line}${RESET}`)
                        .join('\n');
                      console.log(indented);
                    }
                  }
                } catch {
                  // 解析失败则忽略
                }
              }
            });

            res.on('end', () => {
              logger.warn('SSE 连接已断开');
              cleanup();
            });

            res.on('error', (err) => {
              // 主动销毁连接时会触发 aborted 错误，属正常退出，忽略
              if (err.message === 'aborted') return;
              logger.error(`SSE 流错误: ${err.message}`);
              cleanup();
            });
          },
        );

        req.on('error', (err) => {
          logger.error(`无法连接到 Daemon: ${err.message}`);
          process.exit(1);
        });

        req.end();
      });
    };

    // 1. 先建立 SSE 连接并等待确认
    await connect();

    // 2. SSE 就绪后再发送初始化命令（fire-and-forget，不等待设备响应）
    const enableCommands: Array<{ command: string; params: Record<string, any> }> = [];
    if (!allowedTypes || allowedTypes.has('ut')) {
      enableCommands.push({ command: 'UT', params: { isOpen: true } });
    }
    if (!allowedTypes || allowedTypes.has('mtop') || allowedTypes.has('mtop-ssr')) {
      // 保留已有 mock 规则：如果本地 mock 文件存在，带上 mockItems 避免覆盖设备端规则
      let mtopParams: Record<string, any> = { mtopOpen: true };
      if (mockFileExists()) {
        try {
          const file = loadMockFile();
          mtopParams = buildPayload(file, { open: true });
        } catch {
          // mock 文件无效时仅开启上报，不影响 debug 功能
        }
      }
      enableCommands.push({ command: 'mtopMock', params: mtopParams });
    }
    if (!allowedTypes || allowedTypes.has('nav')) {
      enableCommands.push({ command: 'AppLog', params: { isOpen: true } });
    }

    // 并行发送，不阻塞
    Promise.allSettled(
      enableCommands.map((cmd) =>
        sendToDaemon(cmd.command, cmd.params, targetUdid).catch(() => {}),
      ),
    ).then(() => {
      logger.info('已通知设备开启数据上报');
    });
  });

export default debug;
