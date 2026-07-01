import * as logger from './logger.js';
import { ensureConnected } from '../daemon/client.js';
import { getGlobalUdid } from './global-opts.js';
import {
  readSession,
  isSessionExpired,
  clearSession,
} from './session.js';
import type { DeviceClientPublic } from '../socket/command-socket.js';

/**
 * Selector 解析：决定本次命令要下发到哪台设备。
 *
 * 规则（按优先级）：
 *   1. 显式 --udid          -> 校验在线
 *   2. 0 设备               -> 报错"无设备连接"
 *   3. session 命中且在线   -> 使用 session.defaultDeviceId
 *   4. 1 台设备             -> 唯一设备直发
 *   5. ≥2 台设备            -> 报错列候选
 *
 * @returns 目标设备 udid 与当前在线设备列表
 */
export async function resolveTarget(opts?: {
  udid?: string;
}): Promise<{ udid: string; devices: DeviceClientPublic[] }> {
  const explicitUdid = opts?.udid ?? getGlobalUdid();
  const devices = await ensureConnected();

  // 1) 显式 --udid
  if (explicitUdid) {
    const hit = devices.find((d) => d.deviceId === explicitUdid);
    if (!hit) {
      const lines = [
        `指定的 --udid ${explicitUdid} 当前未在线，可用设备：`,
        '',
      ];
      for (const d of devices) {
        lines.push(`  --udid ${d.deviceId}   (${d.platform}·${d.deviceName ?? '-'})`);
      }
      throw new Error(lines.join('\n'));
    }
    return { udid: explicitUdid, devices };
  }

  // 2) 已通过 ensureConnected 兜底，devices 一定 ≥ 1，无需 0 分支

  // 3) session 命中且在线
  const session = readSession();
  if (session) {
    if (isSessionExpired(session)) {
      logger.warn('默认设备记录已过期（>7d），自动清除，请重新设置');
      clearSession();
    } else {
      const sessionHit = devices.find((d) => d.deviceId === session.defaultDeviceId);
      if (sessionHit) {
        return { udid: session.defaultDeviceId, devices };
      }
      logger.warn(
        `默认设备 ${session.defaultDeviceLabel ?? session.defaultDeviceId} 当前未在线`,
      );
    }
  }

  // 4) 单设备直发
  if (devices.length === 1) {
    return { udid: devices[0].deviceId, devices };
  }

  // 5) 多设备无法决断，报错列候选
  const lines = [
    `检测到 ${devices.length} 台已连接设备，请用 --udid 指定：`,
    '',
  ];
  for (const d of devices) {
    lines.push(`  --udid ${d.deviceId}   (${d.platform}·${d.deviceName ?? '-'})`);
  }
  lines.push('', '或执行  hex device use <udid>  设置默认设备');
  throw new Error(lines.join('\n'));
}
