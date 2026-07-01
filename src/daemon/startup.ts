import { CommandSocket } from '../socket/command-socket.js';
import { startDaemon, removeDaemonInfo } from './server.js';
import { releasePort } from '../utils/port.js';
import * as logger from '../utils/logger.js';
import { initLogger } from '../utils/logger.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const DEFAULT_WS_PORT = 12588;
const DEFAULT_IPC_PORT = 12589;

/**
 * Daemon 独立启动入口。
 * 由 ensureDaemon() 通过 spawn detached 方式拉起，在后台常驻运行。
 */
async function main(): Promise<void> {
  // 首件事：初始化日志。
  // daemon 是常驻进程，不走 commander 路径、不会触发 preAction，
  // 必须在入口显式调用，后续所有 logger.* 才能被打上 [daemon] 标签。
  initLogger('daemon', pkg.version);
  const wsPort = parseInt(process.env.HEXCLI_WS_PORT || String(DEFAULT_WS_PORT), 10);
  const ipcPort = parseInt(process.env.HEXCLI_IPC_PORT || String(DEFAULT_IPC_PORT), 10);

  await releasePort(wsPort);
  await releasePort(ipcPort);

  logger.info(`启动 WebSocket Server，端口 ${wsPort}`);
  const socket = new CommandSocket(wsPort);
  await socket.start();

  await startDaemon(wsPort, ipcPort, socket);

  // 保持进程常驻
  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(err);
  removeDaemonInfo();
  process.exit(1);
});
