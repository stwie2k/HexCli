import { Command } from 'commander';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as logger from '../utils/logger.js';
import { type LocalDevice } from '../utils/launcher.js';
import { getGlobalUdid } from '../utils/global-opts.js';
import { resolveLocalTarget } from '../utils/local-target.js';
import { getHarmonyDensityFactor } from './tap.js';

/* ------------------------------------------------------------------ */
/*  共用工具                                                            */
/* ------------------------------------------------------------------ */

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测 xcrun devicectl 是否可用（需 Xcode 15+）。
 * 不可用时给出明确的修复指引，避免用户被原生 ENOENT 困住。
 */
function assertDevicectlAvailable(): void {
  try {
    execSync('xcrun devicectl --version', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
  } catch {
    throw new Error(
      'xcrun devicectl 不可用：获取 iOS 屏幕尺寸需要 Xcode 15+，请升级 Xcode 或在「Xcode → Settings → Locations → Command Line Tools」选择正确版本',
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Android：wm size + wm density → dp                                */
/* ------------------------------------------------------------------ */

export function getAndroidScreenSize(serial: string): { width: number; height: number; dpi: number } {
  if (!commandExists('adb')) {
    throw new Error('adb 未安装或不在 PATH 中');
  }

  let factor: number;
  let dpi: number;
  try {
    const densityOut = execSync(`adb -s ${serial} shell wm density`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const override = densityOut.match(/Override density:\s*(\d+)/);
    const physical = densityOut.match(/Physical density:\s*(\d+)/);
    dpi = Number((override || physical)?.[1]);
    if (!dpi || Number.isNaN(dpi)) {
      throw new Error(`无法解析 density 输出: ${densityOut.trim()}`);
    }
    factor = dpi / 160;
  } catch (err: any) {
    throw new Error(`读取 Android 设备 density 失败: ${err.message}`);
  }

  try {
    const sizeOut = execSync(`adb -s ${serial} shell wm size`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const overrideSize = sizeOut.match(/Override size:\s*(\d+)x(\d+)/);
    const physicalSize = sizeOut.match(/Physical size:\s*(\d+)x(\d+)/);
    const match = overrideSize || physicalSize;
    if (!match) {
      throw new Error(`无法解析 wm size 输出: ${sizeOut.trim()}`);
    }
    const pxW = Number(match[1]);
    const pxH = Number(match[2]);
    return {
      width: Math.round(pxW / factor),
      height: Math.round(pxH / factor),
      dpi,
    };
  } catch (err: any) {
    throw new Error(`读取 Android 屏幕尺寸失败: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  iOS：xcrun devicectl device info displays → nativeSize / pointScale → pt */
/* ------------------------------------------------------------------ */

export interface IOSScreenInfo {
  width: number;
  height: number;
  scale: number;
}

export function getIOSScreenSize(udid: string): IOSScreenInfo {
  assertDevicectlAvailable();
  const tmpFile = path.join(os.tmpdir(), `hex-displays-${udid}.json`);
  try {
    execFileSync(
      'xcrun',
      ['devicectl', 'device', 'info', 'displays', '--device', udid, '--json-output', tmpFile],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    );
    const json = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    const displays: any[] = json?.result?.displays || [];
    const primary = displays.find((d: any) => d.primary) || displays[0];
    if (!primary) {
      throw new Error('devicectl 未返回任何 display 信息');
    }
    const [pxW, pxH] = primary.nativeSize;
    const scale: number = primary.pointScale;
    if (!scale || typeof pxW !== 'number' || typeof pxH !== 'number') {
      throw new Error(`display 数据格式异常: ${JSON.stringify(primary)}`);
    }
    return { width: Math.round(pxW / scale), height: Math.round(pxH / scale), scale };
  } catch (err: any) {
    throw new Error(`获取 iOS 屏幕尺寸失败: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/*  HarmonyOS：hidumper → px → vp（density factor）                    */
/* ------------------------------------------------------------------ */

export function getHarmonyScreenSize(udid: string): { width: number; height: number; density: number } {
  // 1. 获取 RenderService 输出，提取物理分辨率（宽+高）
  const out = execSync(
    `hdc -t ${udid} shell hidumper -s RenderService -a screen`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
  );

  const patterns = [
    /physical resolution=(\d+)x(\d+)/,
    /render resolution=(\d+)x(\d+)/,
    /supportedMode\[0\]:\s*(\d+)x(\d+)/,
    /activeMode:\s*(\d+)x(\d+)/,
  ];
  let pxW: number | undefined;
  let pxH: number | undefined;
  for (const pattern of patterns) {
    const m = out.match(pattern);
    if (m) {
      pxW = Number(m[1]);
      pxH = Number(m[2]);
      break;
    }
  }

  // 2. 获取 density factor（复用 tap.ts 的缓存逻辑）
  const density = getHarmonyDensityFactor(udid);

  // 3. 如果 RenderService 无法解析物理分辨率，报错
  //    （getHarmonyDensityFactor 已包含 DMS 备用路径，density 始终有值）
  if (pxW === undefined || pxH === undefined) {
    throw new Error(
      `无法从 RenderService 解析物理分辨率，请检查设备是否在线:\n${out.slice(0, 200)}`,
    );
  }

  return {
    width: Math.round(pxW / density),
    height: Math.round(pxH / density),
    density,
  };
}

/* ------------------------------------------------------------------ */
/*  命令定义                                                           */
/* ------------------------------------------------------------------ */

const screen = new Command('screen')
  .description(
    '查询设备屏幕宽高（单位与 hex tap 一致：iOS pt、Android dp、HarmonyOS vp）',
  )
  .option('--udid <udid>', '指定设备 UDID/Serial（多设备必填）')
  .action(async (options) => {
    let target: LocalDevice;
    try {
      target = resolveLocalTarget(options.udid ?? getGlobalUdid());
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
    logger.info(`目标设备: ${target.platform}·${target.name} (${target.udid})`);

    try {
      if (target.platform === 'ios') {
        const info = getIOSScreenSize(target.udid);
        console.log(`${info.width}x${info.height} pt @${info.scale}x`);
      } else if (target.platform === 'harmonyos') {
        const size = getHarmonyScreenSize(target.udid);
        console.log(`${size.width}x${size.height} vp @${size.density}x`);
      } else {
        const size = getAndroidScreenSize(target.udid);
        console.log(`${size.width}x${size.height} dp @${size.dpi}dpi`);
      }
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

export { screen };
export default screen;
