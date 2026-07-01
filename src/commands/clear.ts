import { Command } from 'commander';
import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import * as logger from '../utils/logger.js';
import { type LocalDevice } from '../utils/launcher.js';
import { getGlobalUdid } from '../utils/global-opts.js';
import { resolveLocalTarget } from '../utils/local-target.js';
import { dispatchCommand } from '../utils/dispatch.js';
import { DEFAULT_BUNDLE_ID, DEFAULT_HARMONYOS_BUNDLE_ID } from '../utils/constants.js';

/* ------------------------------------------------------------------ */
/*  Android: adb shell pm clear                                        */
/* ------------------------------------------------------------------ */

function clearAndroid(serial: string, bundleId: string): void {
  try {
    const out = execSync(`adb -s ${serial} shell pm clear ${bundleId}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    if (out.trim().toLowerCase().includes('success')) {
      logger.success(`Android 应用 ${bundleId} 数据已清除（等同全新安装）`);
    } else {
      logger.error(`pm clear 返回异常: ${out.trim()}`);
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`清除 Android 应用数据失败: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/*  HarmonyOS: hdc shell bm clean -d -n <bundleId>                     */
/* ------------------------------------------------------------------ */

function clearHarmonyOS(udid: string, bundleId: string): void {
  try {
    const out = execSync(
      `hdc -t ${udid} shell bm clean -n ${bundleId} -d`,
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      },
    );
    const trimmed = out.trim();
    if (trimmed.toLowerCase().includes('success') || trimmed.includes('Succeeded')) {
      logger.success(`HarmonyOS 应用 ${bundleId} 数据已清除（等同全新安装）`);
    } else {
      logger.error(`bm clean 返回异常: ${trimmed}`);
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`清除 HarmonyOS 应用数据失败: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/*  iOS: 通过 Daemon socket 下发 deleteFiles 命令                       */
/* ------------------------------------------------------------------ */

async function clearIOS(udid: string, bundleId: string): Promise<void> {
  // iOS 保护沙盒中的系统目录，无法直接删除目录本身，
  // 需要先获取根目录绝对路径，再列出子项逐个删除。

  // 步骤 1: 获取沙盒根目录（Documents/Library/tmp）的绝对路径
  let rootInfos: { path: string; isDirectory: boolean }[] = [];
  try {
    const rootRes = await dispatchCommand('watchFile', {}, { udid });
    if (rootRes.success) {
      rootInfos = rootRes.result?.fileInfos ?? [];
    }
  } catch { /* ignore */ }

  if (rootInfos.length === 0) {
    logger.error('无法获取沙盒目录信息');
    process.exit(1);
  }

  // 从根目录中找到 Documents / Library / tmp 的绝对路径
  const docDir = rootInfos.find((r) => r.path?.includes('/Documents'))?.path;
  const libDir = rootInfos.find((r) => r.path?.includes('/Library'))?.path;
  const tmpDir = rootInfos.find((r) => r.path?.endsWith('/tmp') || r.path?.includes('/tmp/'))?.path;

  // 要列举子项的目录（绝对路径）
  const dirsToScan: string[] = [];
  if (docDir) dirsToScan.push(docDir);
  if (libDir) {
    // Library 下的子目录也受保护，需要进入子目录列举
    dirsToScan.push(libDir);
  }
  if (tmpDir) dirsToScan.push(tmpDir);

  // 步骤 2: 并发列举所有目录的子项（绝对路径）
  const absPathsToDelete: string[] = [];
  // Library 下的子目录（如 Caches/Preferences）也是受保护的，需要再深入一层
  const libSubDirsToExpand: string[] = [];

  await Promise.allSettled(
    dirsToScan.map(async (dir) => {
      try {
        const res = await dispatchCommand('watchFile', { path: dir }, { udid });
        if (res.success) {
          const infos: any[] = res.result?.fileInfos ?? [];
          for (const f of infos) {
            if (f.path) {
              // Library 的直接子目录需要再展开（它们也受保护）
              if (dir === libDir && f.isDirectory) {
                libSubDirsToExpand.push(f.path);
              } else {
                absPathsToDelete.push(f.path);
              }
            }
          }
        }
      } catch { /* 目录不存在则跳过 */ }
    }),
  );

  // 步骤 2.5: 展开 Library 下受保护的子目录（列出其内容）
  if (libSubDirsToExpand.length > 0) {
    await Promise.allSettled(
      libSubDirsToExpand.map(async (subDir) => {
        try {
          const res = await dispatchCommand('watchFile', { path: subDir }, { udid });
          if (res.success) {
            const infos: any[] = res.result?.fileInfos ?? [];
            if (infos.length > 0) {
              for (const f of infos) {
                if (f.path) absPathsToDelete.push(f.path);
              }
            }
            // 如果子目录为空或列举后仍尝试删除目录本身（可能不受保护）
          } else {
            absPathsToDelete.push(subDir);
          }
        } catch {
          absPathsToDelete.push(subDir);
        }
      }),
    );
  }

  if (absPathsToDelete.length === 0) {
    logger.warn('未找到可清除的文件（沙盒目录为空）');
    return;
  }

  // 步骤 3: 将绝对路径转为相对于 NSHomeDirectory 的相对路径
  // NSHomeDirectory 是 Documents/Library/tmp 的父目录
  const homeDir = docDir ? docDir.replace(/\/Documents$/, '') : '';
  const relativePaths = absPathsToDelete
    .map((p) => homeDir ? p.replace(`${homeDir}/`, '') : p)
    .filter((p) => p.length > 0 && p !== '/');

  logger.info(`共发现 ${relativePaths.length} 个文件/目录待清除...`);

  try {
    const response = await dispatchCommand(
      'deleteFiles',
      { relativePaths },
      { udid },
    );
    if (response.success) {
      const result = response.result?.result ?? response.result;
      const failed: string[] = result?.failed ?? [];
      const realFailures = failed.filter((f: string) => !f.includes('not exist'));
      if (realFailures.length > 0) {
        logger.warn(`部分文件未清除: ${realFailures.join('; ')}`);
      }
      const successCount = (result?.success ?? []).length;
      logger.success(`iOS 应用 ${bundleId} 沙盒数据已清除（${successCount}/${relativePaths.length} 项）`);

      // 停止 app（通过 devicectl 终止进程）
      try {
        // 1. 获取 app 安装路径
        const tmpApps = `/tmp/hex-clear-apps-${Date.now()}.json`;
        execSync(
          `xcrun devicectl device info apps --device ${udid} --json-output ${tmpApps} 2>/dev/null`,
          { stdio: 'pipe', timeout: 15000 },
        );
        const appsData = JSON.parse(readFileSync(tmpApps, 'utf-8'));
        try { unlinkSync(tmpApps); } catch {}
        const apps: any[] = appsData?.result?.apps ?? [];
        const targetApp = apps.find((a: any) => a.bundleIdentifier === bundleId);

        if (targetApp?.url) {
          // 2. 通过安装路径匹配进程
          const tmpProcs = `/tmp/hex-clear-procs-${Date.now()}.json`;
          execSync(
            `xcrun devicectl device info processes --device ${udid} --json-output ${tmpProcs} 2>/dev/null`,
            { stdio: 'pipe', timeout: 15000 },
          );
          const procsData = JSON.parse(readFileSync(tmpProcs, 'utf-8'));
          try { unlinkSync(tmpProcs); } catch {}
          const procs: any[] = procsData?.result?.runningProcesses ?? [];
          const proc = procs.find((p: any) => (p.executable ?? '').startsWith(targetApp.url));
          if (proc?.processIdentifier) {
            execSync(
              `xcrun devicectl device process terminate --device ${udid} --pid ${proc.processIdentifier}`,
              { stdio: 'pipe', timeout: 5000 },
            );
            logger.info('应用已停止');
          }
        }
      } catch {
        // best-effort
      }
    } else {
      logger.error(response.error || '清除 iOS 应用数据失败');
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`清除 iOS 应用数据失败: ${err?.message ?? String(err)}`);
    logger.info('提示: iOS 清除数据需要应用通过 hex open 运行中（Daemon 在线）');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/*  命令定义                                                           */
/* ------------------------------------------------------------------ */

const clear = new Command('clear')
  .description('清除应用本地所有数据（模拟全新安装）')
  .option('--udid <udid>', '指定设备 UDID/Serial（多设备必填）')
  .option('--bundle-id <id>', `目标 App 包名 (默认: ${DEFAULT_BUNDLE_ID})`)
  .action(async (options) => {
    const udid = options.udid ?? getGlobalUdid();

    // Android 不依赖 Daemon，直接走 adb
    // iOS 需要 Daemon 在线（通过 socket 下发 deleteFiles）
    // 先通过 resolveLocalTarget 确定平台
    let target: LocalDevice;
    try {
      target = resolveLocalTarget(udid);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }

    // 用户未显式指定 --bundle-id 时，根据平台自动选择默认包名
    const bundleId = options.bundleId || (
      target.platform === 'harmonyos' ? DEFAULT_HARMONYOS_BUNDLE_ID : DEFAULT_BUNDLE_ID
    );

    logger.info(`目标设备: ${target.platform}·${target.name} (${target.udid})`);
    logger.info(`目标应用: ${bundleId}`);

    if (target.platform === 'android') {
      clearAndroid(target.udid, bundleId);
    } else if (target.platform === 'harmonyos') {
      clearHarmonyOS(target.udid, bundleId);
    } else {
      await clearIOS(target.udid, bundleId);
    }
  });

export default clear;
