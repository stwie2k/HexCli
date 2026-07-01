import { Command } from 'commander';
import { exec } from 'child_process';
import * as logger from '../utils/logger.js';
import { getLocalIP } from '../utils/network.js';
import {
  launchByUdid,
  listLocalDevices,
  findLocalDevice,
  type LocalDevice,
} from '../utils/launcher.js';
import { ensureDaemon } from '../daemon/client.js';
import { listDevices } from '../daemon/client.js';
import { readDaemonInfo, writeDaemonInfo } from '../daemon/server.js';
import { getGlobalUdid } from '../utils/global-opts.js';
import { readSession, isSessionExpired, clearSession } from '../utils/session.js';
import { DEFAULT_BUNDLE_ID, DEFAULT_HARMONYOS_BUNDLE_ID } from '../utils/constants.js';

function getAndroidApmFlagDir(bundleId: string): string {
  return `/sdcard/Android/data/${bundleId}/files/.es`;
}

function runAdbShell(
  udid: string,
  cmd: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    exec(`adb -s ${udid} shell ${cmd}`, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: (stderr || '').trim() });
    });
  });
}

/**
 * 创建 APM 标记文件。路径对齐于 App 端 ESFlag.TMP_DIR。
 *
 * 该路径位于外置存储 /sdcard/Android/data/<pkg>/files/，并非 App 私有沙盒，
 * 不需要 run-as。release/debug 包均可通过 adb shell 直接访问
 * (Android 11+ shell uid 有特例可访问 Android/data)。
 */
async function ensureAndroidApmFlag(bundleId: string, udid: string): Promise<void> {
  const flagDir = getAndroidApmFlagDir(bundleId);
  const flagFile = `${flagDir}/.save_apm_data`;
  const mkdir = await runAdbShell(udid, `mkdir -p ${flagDir}`);
  if (!mkdir.ok) {
    logger.warn(`创建 APM 目录失败（已忽略）: ${mkdir.stderr || 'unknown error'}`);
    return;
  }
  const touchRes = await runAdbShell(udid, `touch ${flagFile}`);
  if (!touchRes.ok) {
    logger.warn(`创建 APM 标记文件失败（已忽略）: ${touchRes.stderr || 'unknown error'}`);
    return;
  }
  logger.info(`已创建 APM 标记文件: ${flagFile}`);
}

/**
 * 按“统一设备选择规则”决定本次 hex open 要拉起的目标设备：
 *   1. 显式 --udid          -> 本机枚举中反查；未连接则报错
 *   2. session 默认设备   -> 如仍在本机枚举中则使用；过期 / 不在线就 fallthrough
 *   3. 单台设备            -> 直接选中
 *   4. 多台设备            -> 报错并列出候选
 *   5. 0 台设备             -> 报错引导接入
 */
function resolveTarget(udid?: string): LocalDevice {
  if (udid) {
    const dev = findLocalDevice(udid);
    if (!dev) {
      throw new Error(`udid ${udid} 未连接到本机，请检查 USB 连接或换一台设备`);
    }
    return dev;
  }

  const devices = listLocalDevices();
  if (devices.length === 0) {
    throw new Error('未检测到任何已连接设备，请先通过 USB 接入 iOS、Android 或 HarmonyOS 设备');
  }

  // session 默认设备（仅在没有显式 --udid 时参与判断）
  const session = readSession();
  if (session) {
    if (isSessionExpired(session)) {
      logger.warn('默认设备记录已过期（>7d），自动清除，请重新设置');
      clearSession();
    } else {
      const sessionHit = devices.find((d) => d.udid === session.defaultDeviceId);
      if (sessionHit) {
        return sessionHit;
      }
      logger.warn(
        `默认设备 ${session.defaultDeviceLabel ?? session.defaultDeviceId} 未连接到本机`,
      );
    }
  }

  if (devices.length === 1) {
    return devices[0];
  }
  // 多设备：报错并列出候选
  const lines = ['检测到多台已连接设备，请使用 --udid 指定目标：', ''];
  for (const d of devices) {
    lines.push(`  hex open --udid ${d.udid}   (${d.platform}·${d.name})`);
  }
  lines.push('', '或执行  hex device use <udid>  设置默认设备');
  throw new Error(lines.join('\n'));
}

/**
 * 启动手机端应用并连接到 Daemon。可被其它命令复用（如 env online/pre 切换后自动重启）。
 * 不会调用 process.exit，失败时抛出异常由调用方决定如何处理。
 */
export async function runOpen(options: {
  udid?: string;
  bundleId?: string;
  noWait?: boolean;
  /**
   * 只接受在此时间戳之后建立的 WebSocket 连接，用于 env 切换后重启场景，
   * 防止 Daemon 中缓存的旧连接被误判为新连接已就绪。
   */
  connectedAfter?: number;
} = {}): Promise<void> {
  await ensureDaemon();

  const info = readDaemonInfo();
  const host = getLocalIP();
  const port = info?.wsPort || 12588;
  const serverUrl = `ws://${host}:${port}`;

  const target = resolveTarget(options.udid);

  // 优先使用显式传入的 bundleId，其次从 daemon.json 中按 udid 查找历史值，最后按平台回退默认值
  const savedBundleId = info?.deviceBundleIds?.[target.udid];
  const platformDefault = target.platform === 'harmonyos' ? DEFAULT_HARMONYOS_BUNDLE_ID : DEFAULT_BUNDLE_ID;
  const bundleId = options.bundleId || savedBundleId || platformDefault;

  // 将当前 udid → bundleId 映射持久化到 daemon.json，供 env 等命令重启时复用
  if (info && savedBundleId !== bundleId) {
    const deviceBundleIds = { ...info.deviceBundleIds, [target.udid]: bundleId };
    writeDaemonInfo({ ...info, deviceBundleIds });
  }

  logger.info(`目标设备: ${target.platform}·${target.name} (${target.udid})`);
  logger.info(`WebSocket Server 地址: ${serverUrl}`);

  if (target.platform === 'android') {
    await ensureAndroidApmFlag(bundleId, target.udid);
  }
  await launchByUdid(bundleId, serverUrl, target.udid);

  if (options.noWait) {
    logger.success('应用已拉起（已跳过连接等待）');
    return;
  }

  logger.info('应用已拉起，等待设备连接到 Daemon...');

  // connectedAfter 用于过滤旧连接：env 切换重启时只接受 launch 之后建立的新连接。
  // 有 connectedAfter 时说明是重启场景，iOS 冷启动可能需要 8-10s，给够时间；
  // 普通首次 open 保持 5s 快速反馈。
  const connectedAfter = options.connectedAfter ?? 0;
  const maxWaitMs = connectedAfter > 0 ? 15_000 : 5_000;
  const intervalMs = 500;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const devices = await listDevices();
      const hit = devices.find(
        (d) => d.deviceId === target.udid && d.connectedAt > connectedAfter,
      );
      if (hit) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.success(
          `已连接：${target.platform}·${hit.deviceName ?? target.name} (${target.udid}) · ${elapsed}s`,
        );
        return;
      }
    } catch {
      // Daemon 瞬间不可达，下一轮重试
    }
  }

  // 超时降级：不报错。可能原因——旧版 SDK 不发 hello / 应用启动较慢 / 网络未就绪。
  // launch 本身已成功，App 已在前台，后续命令仍可能可用。
  const waitSec = maxWaitMs / 1000;
  logger.warn(
    `${waitSec}s 内未检测到设备 ${target.udid} 新连接注册。可能原因：\n` +
      `  • SDK 版本较旧不发送 hello（后续命令仍可调用，建议升级 SDK）\n` +
      `  • 设备与 Mac 不在同一局域网，无法连到 ${serverUrl}\n` +
      `  • 应用启动偏慢，可手动重试  hex open --no-wait`,
  );
}

const open = new Command('open')
  .description('启动手机端应用并连接到 Daemon')
  .option('--udid <udid>', '指定设备 UDID')
  .option('--bundle-id <id>', `目标 App 包名 (默认: ${DEFAULT_BUNDLE_ID})`)
  .option('--no-wait', '不等待设备 hello 注册，launch 后立即返回（适用于旧版 SDK）')
  .action(async (options) => {
    try {
      await runOpen({
        udid: options.udid ?? getGlobalUdid(),
        bundleId: options.bundleId,
        // commander 的 --no-* 会将 wait 设为 false
        noWait: options.wait === false,
      });
      process.exit(0);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

export default open;
