import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { URL } from 'url';
import { CommandSocket } from '../socket/command-socket.js';
import * as logger from '../utils/logger.js';

const DAEMON_INFO_DIR = path.join(os.homedir(), '.hexcli');
const DAEMON_INFO_FILE = path.join(DAEMON_INFO_DIR, 'daemon.json');

export interface DaemonInfo {
  pid: number;
  wsPort: number;
  ipcPort: number;
  startedAt: string;
  /** 各设备使用的 bundleId 映射（udid → bundleId），由 hex open 写入，供 env 重启时复用 */
  deviceBundleIds?: Record<string, string>;
}

export function getDaemonInfoPath(): string {
  return DAEMON_INFO_FILE;
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const content = fs.readFileSync(DAEMON_INFO_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  if (!fs.existsSync(DAEMON_INFO_DIR)) {
    fs.mkdirSync(DAEMON_INFO_DIR, { recursive: true });
  }
  fs.writeFileSync(DAEMON_INFO_FILE, JSON.stringify(info, null, 2));
}

export function removeDaemonInfo(): void {
  try {
    fs.unlinkSync(DAEMON_INFO_FILE);
  } catch {
    // 文件不存在时忽略
  }
}

/**
 * 启动 Daemon 的 HTTP IPC Server，写入 daemon.json，并注册退出清理逻辑。
 *
 * IPC 协议（v3）：
 *   POST /command   body: { command, params, selector: { udid: string } }
 *                  resp: { success, deviceId?, result?, error? }
 *   GET  /devices  resp: DeviceClientPublic[]
 *   GET  /status   resp: { running, devices: DeviceClientPublic[], pid }
 *   GET  /events?udid=<udid>   SSE，过滤指定 udid 的推送
 *   POST /stop
 */
export async function startDaemon(
  wsPort: number,
  ipcPort: number,
  socket: CommandSocket,
): Promise<void> {
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ipcPort}`);

    if (req.method === 'POST' && url.pathname === '/command') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const command: string = parsed.command;
          const params: Record<string, any> | undefined = parsed.params;
          const selector = parsed.selector ?? {};
          const targetUdid: string | undefined = selector.udid;

          if (!command) {
            throw new Error('缺少 command 字段');
          }
          if (!targetUdid) {
            throw new Error('缺少 selector.udid（CLI 必须显式指定目标设备）');
          }

          const result = await socket.dispatch(command, params, targetUdid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: true, deviceId: targetUdid, result }),
          );
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, error: err?.message ?? String(err) }),
          );
        }
      });
    } else if (req.method === 'GET' && url.pathname === '/devices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(socket.listDevices()));
    } else if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          running: true,
          devices: socket.listDevices(),
          pid: process.pid,
        }),
      );
    } else if (req.method === 'POST' && url.pathname === '/disconnect') {
      // 主动断开指定 udid 的连接（hex device disconnect）
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const udid: string | undefined = parsed.udid;
          if (!udid) throw new Error('缺少 udid');
          const ok = socket.disconnectDevice(udid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: ok }));
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, error: err?.message ?? String(err) }),
          );
        }
      });
    } else if (req.method === 'POST' && url.pathname === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Daemon stopping' }));
      // 延迟退出，确保响应发出
      setTimeout(() => {
        removeDaemonInfo();
        process.exit(0);
      }, 500);
    } else if (req.method === 'GET' && url.pathname === '/events') {
      // SSE 流端点 - 将设备推送事件转发到 CLI
      // 支持 ?udid=<udid> 过滤特定设备的推送
      const filterUdid = url.searchParams.get('udid') || null;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // 禁用超时，保持长连接
      res.socket?.setTimeout(0);

      // 发送初始连接确认
      res.write(`data: {"type":"connected","udid":${JSON.stringify(filterUdid)}}\n\n`);

      // 监听 CommandSocket 的 push 事件（含 deviceId）
      const onPush = (event: { deviceId: string; command: string; data: any }) => {
        if (filterUdid && event.deviceId !== filterUdid) return;
        const sseData = JSON.stringify(event);
        res.write(`data: ${sseData}\n\n`);
      };

      socket.on('push', onPush);

      // 客户端断开时清理
      req.on('close', () => {
        socket.removeListener('push', onPush);
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(ipcPort, '127.0.0.1', () => {
      logger.info(`IPC Server 已启动，监听端口 ${ipcPort}`);
      resolve();
    });
  });

  // 写入 Daemon 信息
  writeDaemonInfo({
    pid: process.pid,
    wsPort,
    ipcPort,
    startedAt: new Date().toISOString(),
  });

  // 清理逻辑
  const cleanup = () => {
    removeDaemonInfo();
    try {
      httpServer.close();
    } catch {
      // ignore
    }
    socket.close().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  logger.success('Daemon 已就绪，等待命令...');
}
