import { Command } from 'commander';
import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import * as logger from '../utils/logger.js';
import {
  isDaemonRunning,
  stopDaemon as stopDaemonRequest,
} from '../daemon/client.js';
import { readDaemonInfo, removeDaemonInfo } from '../daemon/server.js';
import { stopDebugWorker, waitForPidExit, type StopResult } from '../utils/debug-worker.js';
import { DEFAULT_BUNDLE_ID } from '../utils/constants.js';
import { getGlobalUdid } from '../utils/global-opts.js';

type StopOrTimeout = StopResult | { status: 'timeout' };

/**
 * 检查 devicectl 是否可用（Xcode 15+ / macOS 14+）
 */
function isDevicectlAvailable(): boolean {
  try {
    execSync('xcrun --find devicectl', { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取已连接的 iOS 设备 UDID，未连接返回 null。
 * 解析 devicectl list devices 输出，识别 connected 状态行中的 UDID。
 */
function getConnectedIOSDeviceUDID(): string | null {
  try {
    const out = execSync('xcrun devicectl list devices 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    for (const line of out.split('\n')) {
      if (!/connected/i.test(line)) continue;
      const m = line.match(/([0-9A-Fa-f-]{36,})/);
      if (m) return m[1];
    }
  } catch {
    // devicectl 自身报错（极少见），按无设备处理
  }
  return null;
}

/**
 * 通过 devicectl 查找指定 bundleId 应用的 PID。
 * 返回 PID 字符串，未找到返回 null。
 */
function findIOSAppPid(udid: string, bundleId: string): string | null {
  try {
    // 1. 获取 app 的安装路径（URL 前缀）
    const tmpApps = `/tmp/hex-apps-${Date.now()}.json`;
    execSync(
      `xcrun devicectl device info apps --device ${udid} --json-output ${tmpApps} 2>/dev/null`,
      { stdio: 'pipe', timeout: 15000 },
    );
    const appsData = JSON.parse(readFileSync(tmpApps, 'utf-8'));
    try { unlinkSync(tmpApps); } catch {}

    const apps: any[] = appsData?.result?.apps ?? [];
    const targetApp = apps.find((a: any) => a.bundleIdentifier === bundleId);
    if (!targetApp?.url) return null;

    // app url 格式: file:///private/var/containers/Bundle/Application/<UUID>/<Name>.app/
    const appUrlPrefix = targetApp.url as string;

    // 2. 获取进程列表，匹配 URL 前缀
    const tmpProcs = `/tmp/hex-procs-${Date.now()}.json`;
    execSync(
      `xcrun devicectl device info processes --device ${udid} --json-output ${tmpProcs} 2>/dev/null`,
      { stdio: 'pipe', timeout: 15000 },
    );
    const procsData = JSON.parse(readFileSync(tmpProcs, 'utf-8'));
    try { unlinkSync(tmpProcs); } catch {}

    const procs: any[] = procsData?.result?.runningProcesses ?? [];
    const proc = procs.find((p: any) => {
      const exe: string = p.executable ?? '';
      return exe.startsWith(appUrlPrefix);
    });
    if (proc?.processIdentifier) return String(proc.processIdentifier);
  } catch {
    // best-effort
  }
  return null;
}

/**
 * iOS: 通过 devicectl 查找目标 App PID 并终止，再 kill xcodebuild test runner 与 iproxy。
 * 无 iOS 设备时整段静默跳过（仅 verbose 输出）。
 */
async function stopIOSAppAndWDA(verbose: boolean, bundleId: string, targetUdid?: string): Promise<void> {
  const progress = verbose ? logger.info : () => {};

  if (!isDevicectlAvailable()) {
    progress('devicectl 不可用，跳过 iOS 处理');
    return;
  }

  // 优先使用上层传入的 udid，否则自动检测
  const udid = targetUdid || getConnectedIOSDeviceUDID();
  if (!udid) {
    progress('未检测到已连接的 iOS 设备，跳过');
    return;
  }

  // 1. 查找目标 App PID 并终止
  try {
    logger.info(`正在查找 App: ${bundleId} (设备: ${udid})...`);
    const pid = findIOSAppPid(udid, bundleId);
    if (pid) {
      execSync(
        `xcrun devicectl device process terminate --device ${udid} --pid ${pid}`,
        { stdio: 'pipe', timeout: 5000 },
      );
      logger.info(`已通过 devicectl 关闭 iOS App: ${bundleId} (PID: ${pid})`);
    } else {
      logger.warn(`未在设备进程列表中找到 ${bundleId}（可能未在运行）`);
    }
  } catch (err: any) {
    progress(`devicectl 关闭 App 未成功: ${err?.message ?? String(err)}`);
  }

  // 2. 杀掉 WDA test runner（xcodebuild test-without-building）
  try {
    execSync('pkill -f "xcodebuild.*test-without-building"', { stdio: 'pipe', timeout: 3000 });
    logger.info('已结束 WDA 自动化测试进程 (xcodebuild)');
  } catch {
    // 没在跑就忽略
  }

  // 3. 杀掉 iproxy 8100 端口转发
  try {
    execSync('pkill -f "iproxy 8100"', { stdio: 'pipe', timeout: 3000 });
    logger.info('已结束 iproxy 8100 端口转发');
  } catch {
    // 没在跑就忽略
  }
}

/**
 * Android: adb force-stop 目标 App
 */
function stopAndroidApp(bundleId: string, targetUdid?: string): void {
  // 快速检测 adb 是否可用
  try {
    execSync('which adb', { stdio: 'pipe', timeout: 2000 });
  } catch {
    return; // 无 adb，直接跳过
  }
  try {
    const out = execSync('adb devices 2>/dev/null', { encoding: 'utf-8', timeout: 2000 });
    const hasDevice = out
      .split('\n')
      .slice(1)
      .some((l) => l.trim() && l.includes('\tdevice'));
    if (!hasDevice) return; // 无连接设备，直接跳过

    const adbPrefix = targetUdid ? `adb -s ${targetUdid}` : 'adb';
    execSync(`${adbPrefix} shell am force-stop ${bundleId}`, { stdio: 'pipe', timeout: 5000 });
    logger.info(`已通过 adb 关闭 Android App: ${bundleId}`);
  } catch {
    // best-effort
  }
}

/**
 * 关闭手机端 App 与自动化测试程序（best-effort，不抛错）
 */
async function stopMobileSide(verbose: boolean, bundleId: string, targetUdid?: string): Promise<void> {
  await stopIOSAppAndWDA(verbose, bundleId, targetUdid);
  stopAndroidApp(bundleId, targetUdid);
}

/**
 * 强制终止 Daemon 进程（SIGTERM → 等 → SIGKILL）
 */
async function forceKillDaemon(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // 已不存在
  }
  if (await waitForPidExit(pid, 2000)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  await waitForPidExit(pid, 1000);
}

const stop = new Command('stop')
  .description('停止当前调试会话（Daemon / App / WDA）')
  .option('-v, --verbose', '显示详细进度日志')
  .option('--udid <udid>', '指定设备 UDID')
  .option('--bundle-id <id>', `目标 App 包名 (默认: ${DEFAULT_BUNDLE_ID})`)
  .action(async (options: { verbose?: boolean; udid?: string; bundleId?: string }) => {
    const progress = options.verbose ? logger.info : () => {};
    const bundleId = options.bundleId || DEFAULT_BUNDLE_ID;
    const targetUdid = options.udid ?? getGlobalUdid();
    progress('开始执行 stop...');

    // 终极安全网：15 秒后强制退出，防止命令永远卡死
    const forceExitTimer = setTimeout(() => {
      logger.warn('stop 命令超时，强制退出');
      removeDaemonInfo();
      process.exit(1);
    }, 15000);
    forceExitTimer.unref(); // 不阻止 Node.js 自然退出
    progress('安全超时已设置 (15s)');

    // 先停手机端（不依赖 Daemon 状态），最多等 10 秒
    progress('正在停止手机端...');
    try {
      await Promise.race([
        stopMobileSide(!!options.verbose, bundleId, targetUdid),
        new Promise<void>((_, reject) => {
          const t = setTimeout(() => reject(new Error('手机端操作超时')), 10000);
          t.unref();
        }),
      ]);
      progress('手机端处理完成');
    } catch (err: any) {
      logger.warn(`手机端停止操作未完成: ${err?.message ?? String(err)}`);
    }

    // 停止后台 debug worker（best-effort，不阻断）
    progress('停止 debug worker...');
    try {
      const result: StopOrTimeout = await Promise.race([
        stopDebugWorker(),
        new Promise<StopOrTimeout>((resolve) => {
          const t = setTimeout(() => resolve({ status: 'timeout' }), 3000);
          t.unref();
        }),
      ]);
      switch (result.status) {
        case 'not-running':
          progress('debug worker 未运行');
          break;
        case 'stale':
          progress(`debug worker 残留信息已清理 (PID ${result.pid})`);
          break;
        case 'stopped':
          logger.info(
            `debug worker 已停止 (PID ${result.pid})${result.forced ? ' [SIGKILL]' : ''}`,
          );
          break;
        case 'failed':
          logger.warn(`debug worker 无法终止 (PID ${result.pid})`);
          break;
        case 'timeout':
          logger.warn('debug worker 停止超时');
          break;
      }
    } catch (err: any) {
      logger.warn(`debug worker 停止异常: ${err?.message ?? String(err)}`);
    }

    progress('读取 Daemon 信息...');
    const info = readDaemonInfo();
    if (!info) {
      logger.warn('未找到 Daemon 信息文件，Daemon 可能未运行');
      process.exit(0);
    }

    progress('Daemon 进程存活检查...');
    if (!isDaemonRunning()) {
      logger.warn(`检测到 Daemon 进程 (PID: ${info.pid}) 已不存在，清理残留信息`);
      removeDaemonInfo();
      process.exit(0);
    }

    // 优先通过 IPC 优雅停止
    progress('发送 IPC 停止请求...');
    try {
      await stopDaemonRequest();
      progress('IPC 请求完成');
    } catch (err: any) {
      logger.warn(`IPC 停止失败: ${err?.message ?? String(err)}，尝试强制终止`);
    }

    // 等待 daemon 真正退出，否则 SIGTERM → SIGKILL 兜底
    progress('等待 Daemon 进程退出...');
    const exited = await waitForPidExit(info.pid, 2000);
    if (!exited) {
      logger.warn(`Daemon (PID: ${info.pid}) 未自动退出，强制终止`);
      await forceKillDaemon(info.pid);
    }

    removeDaemonInfo();
    logger.success(`Daemon 已停止 (PID: ${info.pid})`);
    process.exit(0);
  });

export default stop;
