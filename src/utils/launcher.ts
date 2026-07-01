import { execSync } from 'child_process';
import * as logger from './logger.js';

// 设备类型集中定义在 src/types/device.ts；此处 re-export 保持下游导入路径兼容
export type { DevicePlatform, LocalDevice } from '../types/device.js';
import type { LocalDevice } from '../types/device.js';

/**
 * 检查 devicectl 是否可用，不可用时给出安装引导
 */
function ensureDevicectl(): void {
  try {
    execSync('xcrun --find devicectl', { stdio: 'pipe' });
  } catch {
    logger.error('未找到 devicectl 工具，iOS 设备管理需要安装 Xcode 26.0+');
    logger.info('');
    logger.info('请按以下步骤安装：');
    logger.info('  1. 从 App Store 安装 Xcode（需要 26.0 或更高版本）');
    logger.info('  2. 打开 Xcode 并同意许可协议');
    logger.info('  3. 运行: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer');
    logger.info('  4. 运行: xcode-select --install');
    logger.info('');
    logger.info('安装完成后重新运行此命令即可。');
    process.exit(1);
  }
}

/**
 * 非手机 / 非平板设备黑名单（watchOS / tvOS / audioOS / visionOS / CarPlay）。
 * Hex SDK 仅运行于 iPhone & iPad，枚举阶段优先过滤以避免误选。
 */
const NON_HANDHELD_NAME_PATTERN =
  /Apple\s*Watch|\bWatch\b|Apple\s*TV|\bHomePod\b|Vision\s*Pro|CarPlay/i;

/**
 * 枚举本机已连接的所有 iOS 真机（通过 xcrun xctrace list devices）。
 * 会过滤掉 Apple Watch / Apple TV / HomePod / Vision Pro 等非手机平板设备。
 * 失败或工具缺失时返回空数组（best-effort）。
 */
function listIOSDevices(): LocalDevice[] {
  try {
    const output = execSync('xcrun xctrace list devices 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const devicesSection =
      output.split('== Devices ==')[1]?.split(/==\s/)[0] || '';
    const result: LocalDevice[] = [];
    for (const line of devicesSection.split('\n')) {
      const match = line.match(/\(\d+\.\d+(?:\.\d+)?\)\s+\(([0-9A-Fa-f-]+)\)/);
      if (!match) continue;
      const udid = match[1];
      const nameMatch = line.match(/^(.+?)\s+\(/);
      const name = nameMatch ? nameMatch[1].trim() : 'iOS Device';
      if (NON_HANDHELD_NAME_PATTERN.test(name)) continue;
      result.push({ udid, platform: 'ios', name });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 枚举本机已连接的所有 Android 设备（通过 adb devices -l）。
 * 失败或 adb 缺失时返回空数组（best-effort）。
 */
function listAndroidDevices(): LocalDevice[] {
  try {
    const output = execSync('adb devices -l 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const result: LocalDevice[] = [];
    const lines = output.split('\n').slice(1); // 跳过 "List of devices attached" 表头
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // 格式: <serial>\tdevice product:... model:... device:... transport_id:...
      const m = line.match(/^(\S+)\s+device\b/);
      if (!m) continue;
      const udid = m[1];
      const modelMatch = line.match(/\bmodel:(\S+)/);
      const name = modelMatch ? modelMatch[1].replace(/_/g, ' ') : 'Android Device';
      result.push({ udid, platform: 'android', name });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 枚举本机已连接的所有 HarmonyOS 设备（通过 hdc list targets）。
 * hdc 输出格式极简：每行一个序列号，无表头，无连接状态字段。
 * 失败或 hdc 缺失时返回空数组（best-effort）。
 */
function listHarmonyOSDevices(): LocalDevice[] {
  try {
    const output = execSync('hdc list targets 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const result: LocalDevice[] = [];
    for (const raw of output.split('\n')) {
      const udid = raw.trim();
      if (!udid || udid === '[Empty]') continue;
      let name = 'HarmonyOS Device';
      try {
        const productName = execSync(
          `hdc -t ${udid} shell param get const.product.name 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        if (productName) name = productName.replace(/_/g, ' ');
      } catch {
        // name fallback is non-fatal
      }
      result.push({ udid, platform: 'harmonyos', name });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 枚举本机已连接的所有 iOS + Android + HarmonyOS 设备。
 * 用于多设备 selector：调用方据此判断 0 / 1 / N 台。
 */
export function listLocalDevices(): LocalDevice[] {
  return [...listIOSDevices(), ...listAndroidDevices(), ...listHarmonyOSDevices()];
}

/**
 * 通过 udid 在本机枚举结果中反查平台。
 * 返回 null 表示该 udid 当前未连接到本机。
 */
export function findLocalDevice(udid: string): LocalDevice | null {
  return listLocalDevices().find((d) => d.udid === udid) ?? null;
}

/**
 * 通过 adb 推导 Android 应用的 Launcher Activity。
 * 优先使用 `cmd package query-activities`（Android 7+）解析 name=<pkg>/<Activity>，
 * 因为 resolve-activity 在未明确指定 action+category 或设备多用户场景下
 * 可能返回系统 ResolverActivity（应用选择器）。
 * 推导失败返回 null。
 */
function resolveAndroidLauncherActivity(udid: string, pkg: string): string | null {
  // 优先方案：query-activities 列出所有匹配的 Activity，取第一个
  try {
    const out = execSync(
      `adb -s ${udid} shell cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 3000 },
    );
    // 格式：name=<pkg>.<Activity>
    const m = out.match(/\bname\s*=\s*([\w.]+)\s/);
    if (m && m[1]) {
      return `${pkg}/${m[1]}`;
    }
  } catch {
    // query-activities 不可用，继续尝试 reserve
  }

  // 备选：resolve-activity 显式带 action+category（旧版 Android 兼容）
  try {
    const out = execSync(
      `adb -s ${udid} shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 3000 },
    );
    const lines = out.trim().split('\n');
    const last = lines[lines.length - 1]?.trim();
    if (last && last.includes('/') && !last.includes('ResolverActivity')) {
      return last;
    }
  } catch {
    // resolve-activity 不可用或包未安装
  }
  return null;
}

/**
 * 通过 adb 启动 Android 应用，并把 WebSocket Server 地址 + 设备 UDID 作为启动参数传入。
 * udid 必填：上层 selector 已确保唯一目标。
 *
 * Activity 推导策略：
 *   1. 先通过 `cmd package resolve-activity` 动态获取 LAUNCHER Activity
 *   2. 推导失败时使用 monkey 兜底（让系统自己找 LAUNCHER）
 */
export function launchAndroidApp(
  bundleId: string,
  serverUrl: string,
  udid: string,
): void {
  try {
    try {
      execSync('which adb', { stdio: 'pipe' });
    } catch {
      logger.error('adb 未安装或不在 PATH 中');
      logger.info('请使用 brew install --cask android-platform-tools 安装 adb');
      process.exit(1);
    }

    const adbPrefix = `adb -s ${udid}`;

    // 先强制停止应用，避免旧进程残留
    execSync(`${adbPrefix} shell am force-stop ${bundleId}`, { stdio: 'pipe' });

    // 推导 Launcher Activity
    const activity = resolveAndroidLauncherActivity(udid, bundleId);

    if (activity) {
      // 推导成功：通过 am start -n 精确启动，并传入 intent extra
      execSync(
        `${adbPrefix} shell am start -n ${activity} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER --es Hex_XCTest_Web_Server_Ip "${serverUrl}" --es Hex_Device_UDID "${udid}"`,
        { stdio: 'pipe' },
      );
    } else {
      // 推导失败：用 monkey 兜底启动 LAUNCHER，再通过 broadcast 传参
      logger.warn('Activity 推导失败，使用 monkey 兜底启动');
      execSync(
        `${adbPrefix} shell monkey -p ${bundleId} -c android.intent.category.LAUNCHER 1`,
        { stdio: 'pipe' },
      );
    }

    logger.success(`Android 应用 ${bundleId} 已启动 (设备: ${udid})`);
  } catch (err: any) {
    logger.error(`启动 Android 应用失败: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
}

/**
 * 通过 xcrun devicectl 启动 iOS 应用，并把 WebSocket Server 地址 + 设备 UDID 作为环境变量注入。
 * udid 必填：上层 selector 已确保唯一目标。
 */
export async function launchIOSApp(
  bundleId: string,
  serverUrl: string,
  udid: string,
): Promise<void> {
  try {
    ensureDevicectl();

    // 直接使用 --terminate-existing 启动，会自动终止已运行的实例
    // （devicectl terminate 需要 --pid，不支持直接传 bundleId）

    // 通过 devicectl 启动应用并注入环境变量（包含设备 UDID 用于 SDK hello 注册）
    const envJson = JSON.stringify({
      Hex_XCTest_Web_Server_Ip: serverUrl,
      Hex_Device_UDID: udid,
      HEX_NEED_DARWIN_NOTIFICATION: 'true',
    });

    const launchOutput = execSync(
      `xcrun devicectl device process launch --device ${udid} --terminate-existing --environment-variables '${envJson}' ${bundleId}`,
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    logger.info(`启动输出: ${launchOutput.trim()}`);

    logger.success(`iOS 应用 ${bundleId} 已启动 (设备: ${udid})`);
  } catch (err: any) {
    const message = err?.message ?? String(err);

    if (/Developer Mode is disabled/i.test(message)) {
      logger.error('启动 iOS 应用失败：设备未开启「开发者模式」');
      logger.info('');
      logger.info('请在 iOS 设备上按以下步骤开启：');
      logger.info('  1. 打开「设置」App');
      logger.info('  2. 进入「隐私与安全性」');
      logger.info('  3. 找到并进入「开发者模式」');
      logger.info('  4. 打开开关，根据提示重启设备');
      logger.info('  5. 重启后解锁设备并确认开启');
      logger.info('');
      logger.info('开启后重新运行此命令即可。');
      process.exit(1);
    }

    logger.error(`启动 iOS 应用失败: ${message}`);
    process.exit(1);
  }
}

/**
 * 通过 hdc 启动 HarmonyOS 应用，并把 WebSocket Server 地址 + 设备 UDID 作为 Want 参数注入。
 * udid 必填：上层 selector 已确保唯一目标。
 *
 * Ability 推导策略：
 *   - 默认假设入口 Ability 为 `EntryAbility`（DevEco Studio 工程默认命名，覆盖绝大多数场景）
 *   - 若后续遇到自定义入口 Ability 需求，可扩展到 `aa dump -l` 解析当前包的入口
 *
 * 参数传递契约（需与鸿蒙端 SDK 对齐）：
 *   通过 `aa start --ps key value` 注入 Want 字符串参数，
 *   端侧 SDK 从 `abilityWant.parameters` 读取 `Hex_XCTest_Web_Server_Ip` / `Hex_Device_UDID`。
 *   注意：`--ps` 的 value 不能以 `-` 开头（鸿蒙 hdc 限制）。
 */
export function launchHarmonyOSApp(
  bundleId: string,
  serverUrl: string,
  udid: string,
): void {
  try {
    try {
      execSync('which hdc', { stdio: 'pipe' });
    } catch {
      logger.error('hdc 未安装或不在 PATH 中');
      logger.info('');
      logger.info('请按以下步骤安装：');
      logger.info('  1. 安装 DevEco Studio 或 HarmonyOS Command Line Tools');
      logger.info('  2. 将 sdk/<api-level>/toolchains 目录加入 PATH');
      logger.info('  3. 验证：hdc -v 与 hdc list targets');
      logger.info('');
      process.exit(1);
    }

    const hdcPrefix = `hdc -t ${udid}`;

    // 1. 先强制停止旧进程，避免环境变量未刷新
    //    应用未在运行也会让 aa 返回非 0，此处吞掉异常即可
    try {
      execSync(`${hdcPrefix} shell aa force-stop ${bundleId}`, { stdio: 'pipe' });
    } catch {
      // best-effort
    }

    // 2. 通过 aa start 注入 Want 参数启动应用
    //    - `-d` 显式指定设备（多设备场景更安全）
    //    - `--ps key value` 注入字符串 Want 参数（鸿蒙标准语法）
    //    - serverUrl 形如 ws://192.168.1.x:12588，不含 shell 元字符
    //
    //    注意：hdc shell aa start 即使启动失败（如应用未安装）也返回 exit code 0，
    //    错误信息仅出现在 stdout 中（如 "error: failed to start ability."）。
    //    因此必须捕获 stdout 并检查内容，不能仅依赖 exit code。
    const ability = 'EntryAbility';
    const startOutput = execSync(
      `${hdcPrefix} shell aa start -a ${ability} -b ${bundleId}` +
        ` -d ${udid}` +
        ` --ps Hex_XCTest_Web_Server_Ip ${serverUrl}` +
        ` --ps Hex_Device_UDID ${udid}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    // 检查 stdout 判断是否真正启动成功
    if (startOutput.startsWith('error:') || !startOutput.includes('successfully')) {
      throw new Error(
        `hdc shell aa start 启动失败 (bundleId: ${bundleId})\n${startOutput}`,
      );
    }

    logger.success(`HarmonyOS 应用 ${bundleId} 已启动 (设备: ${udid})`);
  } catch (err: any) {
    logger.error(`启动 HarmonyOS 应用失败: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
}

/**
 * 根据 udid 自动判断平台并启动应用。
 * udid 未连接到本机时抛错。
 */
export async function launchByUdid(
  bundleId: string,
  serverUrl: string,
  udid: string,
): Promise<LocalDevice> {
  const device = findLocalDevice(udid);
  if (!device) {
    throw new Error(`udid ${udid} 未连接到本机`);
  }
  if (device.platform === 'ios') {
    await launchIOSApp(bundleId, serverUrl, udid);
  } else if (device.platform === 'android') {
    launchAndroidApp(bundleId, serverUrl, udid);
  } else {
    // harmonyos
    launchHarmonyOSApp(bundleId, serverUrl, udid);
  }
  return device;
}
