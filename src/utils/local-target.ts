import {
  listLocalDevices,
  findLocalDevice,
  type LocalDevice,
} from './launcher.js';
import { assertSafeUdid } from './udid-safe.js';
import * as logger from './logger.js';
import {
  readSession,
  isSessionExpired,
  clearSession,
} from './session.js';

/**
 * 统一设备选择规则（被 hex screenshot / hex tap / hex swipe / hex screen 等命令复用）。
 *
 * 优先级：
 *   1. 显式 --udid（含全局 --udid）-> 校验本地连接
 *   2. 0 设备                      -> 报错"无设备连接"
 *   3. session 命中且本地已连接     -> 使用 session.defaultDeviceId
 *   4. 仅 1 台设备                  -> 自动选定
 *   5. ≥2 台且未指定                -> 报错列候选
 */
export function resolveLocalTarget(udid?: string): LocalDevice {
  if (udid) {
    // 入口处统一检验：udid 会被拼到 xcrun / adb / pymobiledevice3 命令中，
    // 需拒绝含 shell 元字符的输入（防命令注入）。
    assertSafeUdid(udid);
    const dev = findLocalDevice(udid);
    if (!dev) {
      throw new Error(`udid ${udid} 未连接到本机，请检查 USB 连接或换一台设备`);
    }
    return dev;
  }
  const devices = listLocalDevices();
  if (devices.length === 0) {
    throw new Error('未检测到任何已连接设备，请先通过 USB 接入 iOS 或 Android 设备');
  }

  // session 命中且本地已连接
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
        `默认设备 ${session.defaultDeviceLabel ?? session.defaultDeviceId} 当前未连接到本机`,
      );
    }
  }

  if (devices.length === 1) {
    return devices[0];
  }
  const lines = ['检测到多台已连接设备，请使用 --udid 指定目标：', ''];
  for (const d of devices) {
    lines.push(`  --udid ${d.udid}   (${d.platform}·${d.name})`);
  }
  lines.push('', '或执行  hex device use <udid>  设置默认设备');
  throw new Error(lines.join('\n'));
}
