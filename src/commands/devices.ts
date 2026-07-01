import { Command } from 'commander';
import * as logger from '../utils/logger.js';
import {
  ensureDaemon,
  listDevices,
  disconnectDevice as ipcDisconnectDevice,
} from '../daemon/client.js';
import {
  readSession,
  writeSession,
  clearSession,
  getSessionFilePath,
} from '../utils/session.js';
import { listLocalDevices } from '../utils/launcher.js';
import type { DeviceClientPublic } from '../socket/command-socket.js';

/**
 * 计算连接时长（mm:ss / hh:mm:ss）
 */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 把字符串按显示宽度（中文 2，英文 1）右补空格到指定宽度。
 */
function padDisplay(s: string, width: number): string {
  let w = 0;
  for (const ch of s) {
    // CJK Unified Ideographs / Fullwidth 简单判断
    w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return s + ' '.repeat(Math.max(0, width - w));
}

/**
 * hex device list —— 表格输出本地 USB 设备 + Daemon 在线设备
 */
async function runDeviceList(): Promise<void> {
  await ensureDaemon();

  // 1. 本地 USB 枚举
  const localDevices = listLocalDevices();
  // 2. Daemon 在线设备
  const onlineDevices = await listDevices();
  const onlineMap = new Map<string, DeviceClientPublic>();
  for (const d of onlineDevices) {
    onlineMap.set(d.deviceId, d);
  }

  // 3. 合并：以本地设备为基础，补充仅在线但本地未枚举到的设备
  interface MergedDevice {
    udid: string;
    platform: string;
    name: string;
    usbConnected: boolean;
    wsOnline: boolean;
    appVersion?: string;
    connectedAt?: number;
  }
  const merged: MergedDevice[] = [];
  const seen = new Set<string>();

  for (const local of localDevices) {
    seen.add(local.udid);
    const online = onlineMap.get(local.udid);
    merged.push({
      udid: local.udid,
      platform: local.platform,
      name: online?.deviceName ?? local.name,
      usbConnected: true,
      wsOnline: !!online,
      appVersion: online?.appVersion,
      connectedAt: online?.connectedAt,
    });
  }
  // 仅 daemon 在线、但本地未枚举到的（如无线连接等）
  for (const d of onlineDevices) {
    if (!seen.has(d.deviceId)) {
      merged.push({
        udid: d.deviceId,
        platform: d.platform,
        name: d.deviceName ?? '-',
        usbConnected: false,
        wsOnline: true,
        appVersion: d.appVersion,
        connectedAt: d.connectedAt,
      });
    }
  }

  if (merged.length === 0) {
    logger.info('未检测到任何设备，请通过 USB 接入 iOS 或 Android 设备');
    return;
  }

  const session = readSession();
  const defaultId = session?.defaultDeviceId;
  const now = Date.now();

  // 表头拆成两行：上行是主列名，下行标注 USB / WS 连接类型，避免歧义
  const headerMain = ['#', '默认', '平台', '名称', 'UDID', 'USB', 'WS', 'AppVer', 'WS 时长'];
  const headerSub  = ['',  '',    '',    '',    '',      '(本机)', '(Daemon)', '', ''];
  const rows: string[][] = merged.map((d, i) => [
    String(i + 1),
    d.udid === defaultId ? '★' : '',
    d.platform,
    d.name,
    d.udid,
    d.usbConnected ? '✔' : '✖',
    d.wsOnline ? '✔' : '✖',
    d.wsOnline ? (d.appVersion ?? '-') : '-',
    d.wsOnline && d.connectedAt ? formatDuration(now - d.connectedAt) : '-',
  ]);

  const allRows = [headerMain, headerSub, ...rows];
  const widths = headerMain.map((_, col) => {
    let w = 0;
    for (const row of allRows) {
      let cellWidth = 0;
      for (const ch of row[col] ?? '') {
        cellWidth += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
      }
      if (cellWidth > w) w = cellWidth;
    }
    return w;
  });

  const printRow = (row: string[]) =>
    row.map((c, i) => padDisplay(c, widths[i])).join('  ');

  console.log('');
  console.log(printRow(headerMain));
  console.log(printRow(headerSub));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(printRow(row));
  }
  console.log('');
  logger.info(
    '图例说明: USB = 本机 USB 已接入（可 hex open）；WS = App 已通过 WebSocket 连到 Daemon（可执行命令）',
  );
  if (defaultId) {
    const sessionDevice = merged.find((d) => d.udid === defaultId);
    if (!sessionDevice) {
      logger.warn(`默认设备 ${defaultId} 当前不可见`);
    }
  }
}

/**
 * hex device —— 设备子命令族（list / use / clear / disconnect）
 */
const device = new Command('device').description('设备管理：列表 / 默认设备 / 主动断连');

device
  .command('list')
  .description('列出本地 USB 连接的设备及 Daemon 在线设备')
  .action(async () => {
    try {
      await runDeviceList();
      process.exit(0);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

device
  .command('use <udid>')
  .description('设置默认设备（后续命令免输 --udid）')
  .action(async (udid: string) => {
    try {
      await ensureDaemon();
      const devices = await listDevices();
      const hit = devices.find((d) => d.deviceId === udid);
      if (!hit) {
        logger.warn(`udid ${udid} 当前未在线，仍写入默认设备记录（上线后自动生效）`);
      }
      const label = buildLabel(hit, udid);
      writeSession({
        defaultDeviceId: udid,
        defaultDeviceLabel: label,
        rememberedAt: Date.now(),
        rememberedBy: 'explicit',
      });
      logger.success(`已设置默认设备：${label}`);
      logger.info(`Session 文件：${getSessionFilePath()}`);
      process.exit(0);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

device
  .command('clear')
  .description('清除默认设备记录')
  .action(() => {
    const exists = !!readSession();
    clearSession();
    if (exists) {
      logger.success('已清除默认设备记录');
    } else {
      logger.info('当前没有默认设备记录');
    }
    process.exit(0);
  });

device
  .command('disconnect <udid>')
  .description('主动断开指定 udid 的设备连接（不影响其他设备）')
  .action(async (udid: string) => {
    try {
      await ensureDaemon();
      const ok = await ipcDisconnectDevice(udid);
      if (!ok) {
        logger.warn(`udid ${udid} 当前未在线，已跳过`);
      } else {
        logger.success(`已断开设备 ${udid}`);
      }
      // 若清掉的是默认设备同步失效 session
      const session = readSession();
      if (session && session.defaultDeviceId === udid) {
        clearSession();
        logger.info('该设备为默认设备，已同步清除默认设备记录');
      }
      process.exit(0);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

function buildLabel(device: DeviceClientPublic | undefined, udid: string): string {
  if (!device) return udid;
  const name = device.deviceName ?? '-';
  return `${device.platform}·${name} (${udid})`;
}

export { device };
export default device;
