import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readDaemonInfo } from './server.js';
import type { DeviceClientPublic } from '../socket/command-socket.js';

export interface CommandResult {
  success: boolean;
  deviceId?: string;
  result?: any;
  error?: string;
}

const DEFAULT_WS_PORT = 12588;
const DEFAULT_IPC_PORT = 12589;

/**
 * 检查 Daemon 是否真实运行（同时校验 daemon.json 与进程存活）。
 */
export function isDaemonRunning(): boolean {
  const info = readDaemonInfo();
  if (!info) return false;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 daemon startup 脚本路径（打包后位于 dist/daemon/startup.js）。
 */
function resolveStartupScript(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // 打包后 client.ts 被内联进 dist/index.js，所以 __dirname 即为 dist 目录
  return path.resolve(__dirname, 'daemon', 'startup.js');
}

/**
 * 确保 Daemon 正在运行。如果未运行则自动在后台启动一个独立进程。
 */
export async function ensureDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    return;
  }

  const startupScript = resolveStartupScript();
  const child = spawn(process.execPath, [startupScript], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      HEXCLI_WS_PORT: String(DEFAULT_WS_PORT),
      HEXCLI_IPC_PORT: String(DEFAULT_IPC_PORT),
    },
  });
  child.unref();

  // 轮询等待 Daemon 启动就绪
  const maxWait = 8000;
  const interval = 200;
  let waited = 0;
  while (waited < maxWait) {
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
    if (isDaemonRunning()) {
      return;
    }
  }
  throw new Error('Daemon 自动启动超时，请检查端口占用或日志');
}

/**
 * 通用 IPC 请求（GET）。
 */
function ipcGet(url: string): Promise<string> {
  const info = readDaemonInfo();
  if (!info) return Promise.reject(new Error('Daemon 未运行'));

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: info.ipcPort,
        path: url,
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', (err) => reject(new Error(`IPC GET ${url} 失败: ${err.message}`)));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error(`IPC GET ${url} 超时`));
    });
    req.end();
  });
}

/**
 * 查询当前已连接设备列表。
 */
export async function listDevices(): Promise<DeviceClientPublic[]> {
  const data = await ipcGet('/devices');
  try {
    return JSON.parse(data) as DeviceClientPublic[];
  } catch {
    throw new Error('Daemon /devices 响应解析失败');
  }
}

/**
 * 确保 Daemon 运行且至少有一台设备已连接。
 * 用于所有需要设备连接才能执行的命令（与 selector 解析配合）。
 */
export async function ensureConnected(): Promise<DeviceClientPublic[]> {
  await ensureDaemon();
  const devices = await listDevices();
  if (devices.length === 0) {
    throw new Error('当前没有已连接的设备，请先执行: hex open');
  }
  return devices;
}

/**
 * 通过 HTTP IPC 通道向 Daemon 发送命令，由 Daemon 转发到指定设备并返回响应。
 *
 * @param command 命令名
 * @param params  命令参数
 * @param target  目标设备 UDID（必填，由上层 selector 解析得出）
 */
export async function sendToDaemon(
  command: string,
  params: Record<string, any> | undefined,
  target: string,
): Promise<CommandResult> {
  const info = readDaemonInfo();
  if (!info) {
    throw new Error('Daemon 未运行');
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      command,
      params: params || {},
      selector: { udid: target },
    });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: info.ipcPort,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('解析 Daemon 响应失败'));
          }
        });
      },
    );

    req.on('error', (err) => {
      reject(new Error(`无法连接到 Daemon: ${err.message}`));
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Daemon 响应超时'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * 通知 Daemon 主动断开指定 udid 的连接。
 */
export async function disconnectDevice(udid: string): Promise<boolean> {
  const info = readDaemonInfo();
  if (!info) throw new Error('Daemon 未运行');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ udid });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: info.ipcPort,
        path: '/disconnect',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(!!parsed.success);
          } catch {
            reject(new Error('Daemon /disconnect 响应解析失败'));
          }
        });
      },
    );
    req.on('error', (err) =>
      reject(new Error(`Daemon /disconnect 失败: ${err.message}`)),
    );
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Daemon /disconnect 超时'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 通知 Daemon 退出。
 * 注意：daemon 收到 /stop 后会 setTimeout 500ms 然后 process.exit，
 * socket 可能在响应到达前被对端关闭（ECONNRESET），视为成功。
 */
export async function stopDaemon(): Promise<void> {
  const info = readDaemonInfo();
  if (!info) {
    throw new Error('Daemon 未运行');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: info.ipcPort,
        path: '/stop',
        method: 'POST',
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => done());
        // 对端在响应过程中退出，也算成功
        res.on('close', () => done());
      },
    );
    req.on('error', (err: any) => {
      // daemon 已退出导致连接断开，视为成功
      if (err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED') {
        done();
      } else {
        done(err);
      }
    });
    req.setTimeout(3000, () => {
      req.destroy();
      done(new Error('stopDaemon 请求超时'));
    });
    req.end();
  });
}
