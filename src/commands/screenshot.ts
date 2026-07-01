import { Command } from 'commander';
import { execSync, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import * as logger from '../utils/logger.js';
import { checkWDA, captureScreenshot as wdaCaptureScreenshot } from '../utils/wda.js';
import { type LocalDevice } from '../utils/launcher.js';
import { getGlobalUdid } from '../utils/global-opts.js';
import { resolveLocalTarget } from '../utils/local-target.js';

/**
 * 检查命令是否可用
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查 pymobiledevice3 是否安装
 */
function checkPymobiledevice3(): boolean {
  try {
    execSync('pymobiledevice3 version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * HarmonyOS 截图（通过 hdc uitest screenCap + hdc file recv）
 */
function captureHarmonyOS(outputPath: string, udid: string): void {
  const hdcPrefix = `hdc -t ${udid}`;
  const remotePath = '/data/local/tmp/hex_screenshot.png';
  logger.info(`正在对 HarmonyOS 设备 (${udid}) 截图...`);

  try {
    // 使用 uitest screenCap 截图到设备临时目录
    execSync(`${hdcPrefix} shell uitest screenCap -p ${remotePath}`, {
      stdio: 'pipe',
      timeout: 10000,
    });

    // 从设备拉取到本地
    execSync(`${hdcPrefix} file recv ${remotePath} ${outputPath}`, {
      stdio: 'pipe',
      timeout: 10000,
    });

    // 清理设备临时文件
    execSync(`${hdcPrefix} shell rm -f ${remotePath}`, { stdio: 'pipe', timeout: 3000 });

    if (fs.existsSync(outputPath)) {
      logger.success(`截图已保存: ${outputPath}`);
    } else {
      throw new Error('截图文件未生成');
    }
  } catch (err: any) {
    // fallback: 尝试 snapshot_display
    try {
      logger.warn('uitest screenCap 失败，尝试 snapshot_display...');
      execSync(`${hdcPrefix} shell snapshot_display -f ${remotePath}`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      execSync(`${hdcPrefix} file recv ${remotePath} ${outputPath}`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      execSync(`${hdcPrefix} shell rm -f ${remotePath}`, { stdio: 'pipe', timeout: 3000 });

      if (fs.existsSync(outputPath)) {
        logger.success(`截图已保存: ${outputPath}`);
        return;
      }
    } catch {}
    logger.error(`HarmonyOS 截图失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Android 截图
 */
function captureAndroid(outputPath: string, udid: string): void {
  if (!commandExists('adb')) {
    logger.error('adb 未安装或不在 PATH 中');
    logger.info('请使用 brew install --cask android-platform-tools 安装 adb');
    process.exit(1);
  }

  const deviceSerial = udid;
  const adbPrefix = `adb -s ${deviceSerial}`;
  logger.info(`正在对 Android 设备 (${deviceSerial}) 截图...`);

  try {
    const buffer = execSync(`${adbPrefix} exec-out screencap -p`, {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for high-res screens
    });
    fs.writeFileSync(outputPath, buffer);
    logger.success(`截图已保存: ${outputPath}`);
  } catch (err: any) {
    logger.error(`Android 截图失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * 检查 tunneld 进程是否存在（不保证健康）
 */
function isTunneldRunning(): boolean {
  try {
    const output = execSync('pgrep -f "pymobiledevice3 remote tunneld"', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const pids = output.trim().split('\n').filter(p => p.trim().length > 0);
    return pids.length > 0;
  } catch {
    return false;
  }
}

/**
 * 读取 tunneld 注册表（HTTP API）。任何错误返回 null。
 */
function getTunneldDevices(): Record<string, unknown> | null {
  try {
    const output = execSync('curl -s --max-time 2 http://127.0.0.1:49151', {
      encoding: 'utf-8',
      timeout: 4000,
    });
    const trimmed = output.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 检查指定 UDID 是否已被 tunneld 接管
 */
function isDeviceTunneled(udid: string): boolean {
  const devices = getTunneldDevices();
  if (!devices) return false;
  if (Object.prototype.hasOwnProperty.call(devices, udid)) return true;
  const lower = udid.toLowerCase();
  return Object.keys(devices).some(k => k.toLowerCase() === lower);
}

/**
 * 端口 49151 是否已释放（curl 应连接拒绝）
 */
function isTunneldPortFree(): boolean {
  try {
    execSync('curl -s --max-time 1 http://127.0.0.1:49151', {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * 轮询等待目标设备出现在 tunneld 注册表中
 */
function waitForDeviceTunneled(udid: string, timeoutMs = 30000): boolean {
  const startTs = Date.now();
  let lastNotice = 0;
  while (Date.now() - startTs < timeoutMs) {
    if (isDeviceTunneled(udid)) return true;
    const elapsed = Date.now() - startTs;
    if (elapsed - lastNotice >= 2000) {
      const seconds = Math.floor(elapsed / 1000);
      logger.info(`等待 tunneld 发现设备...（已等待 ${seconds}s）`);
      lastNotice = elapsed;
    }
    execSync('sleep 1');
  }
  return false;
}

/**
 * 杀掉所有 tunneld 进程并等待端口释放（调用方需先 sudo -v 刷新凭证）
 */
function killTunneld(): void {
  try {
    execSync('sudo -n pkill -TERM -f "pymobiledevice3 remote tunneld"', {
      stdio: 'pipe',
      timeout: 3000,
    });
  } catch {
    // 没有匹配进程或权限失败都先忽略，下面会复查
  }
  execSync('sleep 1');
  if (isTunneldRunning()) {
    try {
      execSync('sudo -n pkill -KILL -f "pymobiledevice3 remote tunneld"', {
        stdio: 'pipe',
        timeout: 3000,
      });
    } catch {}
    execSync('sleep 1');
  }
  for (let i = 0; i < 5; i++) {
    if (!isTunneldRunning() && isTunneldPortFree()) return;
    execSync('sleep 0.5');
  }
}

/**
 * 后台启动 tunneld（调用方需先确认 sudo 凭证已刷新）
 */
function startTunneld(): void {
  let pymPath: string;
  try {
    pymPath = execSync('which pymobiledevice3', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    logger.error('pymobiledevice3 路径未找到');
    process.exit(1);
  }
  try {
    execSync(`sudo -n nohup ${pymPath} remote tunneld >/dev/null 2>&1 &`, {
      shell: '/bin/zsh',
      timeout: 5000,
    });
  } catch {
    // 后台命令可能 timeout，忽略
  }
}

/**
 * 刷新 sudo 凭证（交互式输入密码）。失败则报错并退出。
 */
function refreshSudo(): void {
  try {
    execSync('sudo -v', { stdio: 'inherit', timeout: 30000 });
  } catch {
    logger.error('需要 sudo 权限来管理 tunneld 服务');
    process.exit(1);
  }
}

/**
 * 确保指定设备已被 tunneld 接管。状态机：
 *   A. 注册表已含 UDID → 直接返回
 *   B. tunneld 未运行 → sudo + 启动 + 等待
 *   C. tunneld 在跑但注册表无 UDID（含 B 超时落到此）→ 重启 tunneld + 等待
 *   D. 仍失败 → 输出可执行诊断，exit 1
 */
function ensureDeviceTunneled(udid: string): void {
  // A. 已就绪
  if (isDeviceTunneled(udid)) return;

  // B. 完全没起 tunneld
  if (!isTunneldRunning()) {
    logger.info('iOS 17+ 需要 tunneld 服务，正在启动...');
    logger.info('首次启动需要输入 sudo 密码：');
    refreshSudo();
    startTunneld();
    if (waitForDeviceTunneled(udid, 30000)) {
      logger.success('tunneld 服务已就绪');
      return;
    }
    logger.warn('tunneld 已启动但未发现目标设备，将尝试重启...');
  }

  // C. tunneld 在跑但注册表无目标设备（或 B 超时）
  logger.warn('tunneld 注册表中未发现设备，正在重启 tunneld...');
  refreshSudo();
  killTunneld();
  startTunneld();
  if (waitForDeviceTunneled(udid, 30000)) {
    logger.success('tunneld 服务已就绪');
    return;
  }

  // D. 仍然失败
  logger.error('tunneld 无法发现该 iOS 设备');
  logger.info('');
  logger.info('请按以下顺序排查：');
  logger.info('  1. 在 iPhone 屏幕上确认是否弹出"信任此电脑"，点击信任');
  logger.info('  2. 解锁屏幕后重试');
  logger.info('  3. 拔插数据线，或更换数据线 / USB 端口（避免使用 Hub）');
  logger.info('  4. 检查 设置 → 隐私与安全 → 开发者模式 是否开启');
  logger.info('  5. 若多次复现，可能是 pymobiledevice3 与当前 iOS 版本兼容性问题，建议固定到已知良好版本');
  logger.info('');
  process.exit(1);
}

/**
 * 通过 WDA 截图（如果 WDA 在跑则优先走这条路径，免 sudo / 免 tunneld）
 * 成功返回 true，失败返回 false（由调用方决定是否 fallback）
 */
async function captureViaWDA(outputPath: string, udid: string): Promise<boolean> {
  if (!(await checkWDA(udid))) return false;
  try {
    logger.info('检测到 WDA 服务，通过 WDA 截图...');
    const png = await wdaCaptureScreenshot(udid, 15000);
    fs.writeFileSync(outputPath, png);
    logger.success(`截图已保存: ${outputPath}`);
    return true;
  } catch (err: any) {
    logger.warn(`WDA 截图失败，回退到 pymobiledevice3: ${err.message}`);
    return false;
  }
}

/**
 * iOS 截图
 */
async function captureIOS(outputPath: string, udid: string): Promise<void> {
  // 优先走 WDA 路径（无需 sudo / pymobiledevice3 / tunneld）
  if (await captureViaWDA(outputPath, udid)) return;

  if (!checkPymobiledevice3()) {
    logger.error('pymobiledevice3 未安装，iOS 截图需要此工具');
    logger.info('');
    logger.info('请执行以下命令安装：');
    logger.info('  brew install pipx && pipx ensurepath && pipx install pymobiledevice3');
    logger.info('（或先启动 WDA：hex tap 等命令会自动部署 WDA，之后截图可走 WDA 链路）');
    logger.info('');
    process.exit(1);
  }

  const deviceId = udid;

  // 自动确保 tunneld 已接管目标设备（iOS 17+ 需要）
  ensureDeviceTunneled(deviceId);

  logger.info(`正在对 iOS 设备 (${deviceId}) 截图...`);

  // 尝试 pymobiledevice3 dvt screenshot（iOS 17+）
  // 安全：deviceId / outputPath 走 execFileSync argv，不过 shell，即使含特殊字符也不会注入
  let result = '';
  try {
    const out = execFileSync(
      'pymobiledevice3',
      ['developer', 'dvt', 'screenshot', outputPath, '--udid', deviceId],
      {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    result = out || '';
    if (fs.existsSync(outputPath)) {
      logger.success(`截图已保存: ${outputPath}`);
      return;
    }
    if (result.trim()) {
      logger.warn(result.trim());
    }
    logger.warn('DVT 截图未生成文件，尝试备用方案...');
  } catch (err: any) {
    if (fs.existsSync(outputPath)) {
      logger.success(`截图已保存: ${outputPath}`);
      return;
    }
    const stderr = err?.stderr ? err.stderr.toString() : '';
    const stdout = err?.stdout ? err.stdout.toString() : '';
    const merged = (stderr + stdout).trim() || err?.message || '';
    logger.warn(`DVT 截图失败，尝试备用方案... ${merged.includes('tunneld') ? '(tunneld 可能未就绪)' : ''}`);
  }

  // 备用：pymobiledevice3 developer screenshot（iOS < 17）
  try {
    const out = execFileSync(
      'pymobiledevice3',
      ['developer', 'screenshot', outputPath, '--udid', deviceId],
      {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (fs.existsSync(outputPath)) {
      logger.success(`截图已保存: ${outputPath}`);
      return;
    }
    const trimmed = (out || '').trim();
    if (trimmed) logger.warn(trimmed);
  } catch (err: any) {
    if (fs.existsSync(outputPath)) {
      logger.success(`截图已保存: ${outputPath}`);
      return;
    }
    const stderr = err?.stderr ? err.stderr.toString() : '';
    const stdout = err?.stdout ? err.stdout.toString() : '';
    const merged = (stderr + stdout).trim() || err?.message || '';
    if (merged) logger.warn(merged);
  }

  // 两种方式都失败
  logger.error('iOS 截图失败');
  logger.info('');
  logger.info('请尝试以下排查步骤：');
  logger.info('  1. 在 iPhone 屏幕上确认是否弹出"信任此电脑"，点击信任');
  logger.info('  2. 解锁屏幕后重试');
  logger.info('  3. 拔插数据线，或更换数据线 / USB 端口（避免使用 Hub）');
  logger.info('  4. 检查 设置 → 隐私与安全 → 开发者模式 是否开启');
  logger.info('');
  process.exit(1);
}

const screenshot = new Command('screenshot')
  .description('对连接的设备进行截图')
  .option('-o, --output <path>', '截图保存路径')
  .option('--udid <udid>', '指定设备 UDID/Serial（多设备必填）')
  .action(async (options) => {
    // 确定输出路径
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(process.env.HOME || '~', 'Desktop', `screenshot_${timestamp}.png`);

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 解析目标设备：仅 --udid 显式入口（含全局 --udid）
    let target: LocalDevice;
    try {
      target = resolveLocalTarget(options.udid ?? getGlobalUdid());
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
    logger.info(`目标设备: ${target.platform}·${target.name} (${target.udid})`);

    if (target.platform === 'android') {
      captureAndroid(outputPath, target.udid);
    } else if (target.platform === 'harmonyos') {
      captureHarmonyOS(outputPath, target.udid);
    } else {
      await captureIOS(outputPath, target.udid);
    }
  });

export default screenshot;
