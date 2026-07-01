import { execSync } from 'child_process';
import * as logger from './logger.js';

/**
 * 释放指定端口占用：通过 lsof 找到占用进程并 kill。
 * 释放完成后等待一段时间确保端口完全释放。
 */
export async function releasePort(port: number): Promise<void> {
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    if (pids.length === 0) {
      return;
    }

    for (const pid of pids) {
      try {
        execSync(`kill ${pid}`, { stdio: 'pipe' });
        logger.info(`已释放端口 ${port} (PID: ${pid})`);
      } catch {
        // 单个 PID kill 失败时忽略，继续处理其他 PID
      }
    }

    // 等待端口完全释放
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // 端口未被占用，无需处理
  }
}
