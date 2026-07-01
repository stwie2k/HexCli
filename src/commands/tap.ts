import { Command } from 'commander';
import { execSync, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import * as logger from '../utils/logger.js';
import { wdaRequest, checkWDA, getOrCreateSession } from '../utils/wda.js';
import {
  getPortForUdid,
  getMappedPortForUdid,
  releasePortForUdid,
  clearAllPorts,
} from '../utils/wda-ports.js';
import { type LocalDevice } from '../utils/launcher.js';
import { getGlobalUdid } from '../utils/global-opts.js';
import { assertSafeUdid } from '../utils/udid-safe.js';
import { resolveLocalTarget } from '../utils/local-target.js';
import { getIOSScreenSize, getAndroidScreenSize } from './screen.js';
import { dumpHarmonyLayout, parseBounds, findNodesByText } from '../utils/harmony-layout.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * 缓存设备 density factor（同进程内只查一次）
 */
const androidDensityCache = new Map<string, number>();

/**
 * 获取 Android 设备 density factor (dpi / 160)
 * 用于把 dp 换算为物理像素：px = round(dp * factor)
 */
function getAndroidDensityFactor(serial: string): number {
  const cached = androidDensityCache.get(serial);
  if (cached !== undefined) return cached;

  try {
    const out = execSync(`adb -s ${serial} shell wm density`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Override density 优先于 Physical density
    const override = out.match(/Override density:\s*(\d+)/);
    const physical = out.match(/Physical density:\s*(\d+)/);
    const dpi = Number((override || physical)?.[1]);
    if (!dpi || Number.isNaN(dpi)) {
      throw new Error(`无法解析 density 输出: ${out.trim()}`);
    }
    const factor = dpi / 160;
    androidDensityCache.set(serial, factor);
    return factor;
  } catch (err: any) {
    logger.error(`读取 Android 设备 density 失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * dp → 物理像素
 */
function dpToPx(dp: number, factor: number): number {
  return Math.round(dp * factor);
}

/**
 * 解析数值参数
 */
function parseNumber(value: string | undefined, name: string): number {
  if (value === undefined || value === '') {
    logger.error(`参数 ${name} 不能为空`);
    process.exit(1);
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    logger.error(`参数 ${name} 必须是数字: ${value}`);
    process.exit(1);
  }
  return num;
}

function warnIfOutOfBounds(points: Array<[number, number]>, target: LocalDevice): void {
  try {
    const size = target.platform === 'ios'
      ? getIOSScreenSize(target.udid)
      : getAndroidScreenSize(target.udid);
    const unit = target.platform === 'ios' ? 'pt' : 'dp';
    for (const [x, y] of points) {
      if (x < 0 || x > size.width || y < 0 || y > size.height) {
        logger.warn(`坐标 (${x}, ${y}) 超出屏幕范围 ${size.width}x${size.height} ${unit}`);
      }
    }
  } catch {}
}

/**
 * 缓存 HarmonyOS 设备 density factor
 */
const harmonyDensityCache = new Map<string, number>();

/**
 * 从 RenderService 输出中解析屏幕宽度（像素）。
 * 不同机型输出字段可能不同，依次尝试多种模式。
 */
export function parseRenderServiceWidth(out: string): number | undefined {
  const patterns = [
    /physical resolution=(\d+)x(\d+)/,
    /render resolution=(\d+)x(\d+)/,
    /supportedMode\[0\]:\s*(\d+)x(\d+)/,
    /activeMode:\s*(\d+)x(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = out.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * 从 DisplayManagerService 输出中直接解析 Density。
 * 部分机型（如 Mate XT）RenderService 输出不完整，但 DMS 仍能提供 density。
 */
export function parseDisplayManagerDensity(udid: string): number | undefined {
  try {
    const out = execSync(
      `hdc -t ${udid} shell hidumper -s DisplayManagerService -a -a`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
    );
    // 优先使用 DensityInCurResolution，回退到 Density
    const match =
      out.match(/DensityInCurResolution:\s*(\d+(?:\.\d+)?)/) ??
      out.match(/Density:\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const factor = Number(match[1]);
      if (!Number.isNaN(factor) && factor > 0) return factor;
    }
  } catch {
    // best-effort fallback
  }
  return undefined;
}

/**
 * 获取 HarmonyOS 设备 density factor (physicalWidth / vpWidth)
 * HarmonyOS uitest 坐标使用物理像素，需要把 vp 转为 px
 * vp → px: px = round(vp * factor)
 */
export function getHarmonyDensityFactor(udid: string): number {
  const cached = harmonyDensityCache.get(udid);
  if (cached !== undefined) return cached;

  try {
    const out = execSync(
      `hdc -t ${udid} shell hidumper -s RenderService -a screen`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
    );

    const physicalWidth = parseRenderServiceWidth(out);
    if (physicalWidth === undefined) {
      throw new Error(`无法解析屏幕分辨率: ${out.slice(0, 200)}`);
    }

    // 通过 phyWidth(mm) 和分辨率推算 dpi，或使用 DisplayManagerService 的 Density
    const phyWidthMatch = out.match(/phyWidth=(\d+)/);
    if (phyWidthMatch) {
      const phyWidthMm = Number(phyWidthMatch[1]);
      const dpi = Math.round((physicalWidth / phyWidthMm) * 25.4);
      const factor = dpi / 160;
      harmonyDensityCache.set(udid, factor);
      return factor;
    }

    // RenderService 没有 phyWidth，尝试 DMS 的 Density
    const dmsDensity = parseDisplayManagerDensity(udid);
    if (dmsDensity !== undefined) {
      harmonyDensityCache.set(udid, dmsDensity);
      return dmsDensity;
    }

    // fallback: 常见鸿蒙设备 density = 3
    const factor = 3;
    harmonyDensityCache.set(udid, factor);
    return factor;
  } catch (err: any) {
    logger.warn(`获取 HarmonyOS density 失败，使用默认值 3: ${err.message}`);
    const factor = parseDisplayManagerDensity(udid) ?? 3;
    harmonyDensityCache.set(udid, factor);
    return factor;
  }
}

/**
 * HarmonyOS 点击（通过 hdc uitest uiInput）
 */
function tapHarmonyOS(x: number, y: number, duration: number | undefined, udid: string): void {
  const hdcPrefix = `hdc -t ${udid}`;
  const factor = getHarmonyDensityFactor(udid);
  const px = dpToPx(x, factor);
  const py = dpToPx(y, factor);

  try {
    if (duration && duration > 0) {
      logger.info(
        `正在对 HarmonyOS 设备 (${udid}) 在 (${x}, ${y}) vp [→ ${px}, ${py} px] 长按...`
      );
      execSync(`${hdcPrefix} shell uitest uiInput longClick ${px} ${py}`, { stdio: 'pipe', timeout: 10000 });
    } else {
      logger.info(
        `正在对 HarmonyOS 设备 (${udid}) 点击 (${x}, ${y}) vp [→ ${px}, ${py} px]...`
      );
      execSync(`${hdcPrefix} shell uitest uiInput click ${px} ${py}`, { stdio: 'pipe', timeout: 10000 });
    }
    logger.success('点击完成');
  } catch (err: any) {
    logger.error(`HarmonyOS 点击失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * HarmonyOS 滑动（通过 hdc uitest uiInput）
 */
function swipeHarmonyOS(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  duration: number,
  udid: string,
): void {
  const hdcPrefix = `hdc -t ${udid}`;
  const factor = getHarmonyDensityFactor(udid);
  const px1 = dpToPx(x1, factor);
  const py1 = dpToPx(y1, factor);
  const px2 = dpToPx(x2, factor);
  const py2 = dpToPx(y2, factor);

  // uitest swipe velocity 范围 200-40000，根据 duration 换算
  // velocity ≈ distance / (duration/1000)，单位约为 px/s
  const distance = Math.sqrt(Math.pow(px2 - px1, 2) + Math.pow(py2 - py1, 2));
  const velocity = Math.max(200, Math.min(40000, Math.round(distance / (duration / 1000))));

  logger.info(
    `正在对 HarmonyOS 设备 (${udid}) 从 (${x1}, ${y1}) → (${x2}, ${y2}) vp ` +
      `[(${px1}, ${py1}) → (${px2}, ${py2}) px]，velocity=${velocity}...`
  );

  try {
    execSync(`${hdcPrefix} shell uitest uiInput swipe ${px1} ${py1} ${px2} ${py2} ${velocity}`, {
      stdio: 'pipe',
      timeout: Math.max(10000, duration + 5000),
    });
    logger.success('滑动完成');
  } catch (err: any) {
    logger.error(`HarmonyOS 滑动失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Android 点击
 */
function tapAndroid(x: number, y: number, duration: number | undefined, serial: string): void {
  if (!commandExists('adb')) {
    logger.error('adb 未安装或不在 PATH 中');
    logger.info('请使用 brew install --cask android-platform-tools 安装 adb');
    process.exit(1);
  }

  const adbPrefix = `adb -s ${serial}`;
  const factor = getAndroidDensityFactor(serial);
  const px = dpToPx(x, factor);
  const py = dpToPx(y, factor);

  try {
    if (duration && duration > 0) {
      logger.info(
        `正在对 Android 设备 (${serial}) 在 (${x}, ${y}) dp [→ ${px}, ${py} px] 长按 ${duration}ms...`
      );
      execSync(`${adbPrefix} shell input swipe ${px} ${py} ${px} ${py} ${duration}`, { stdio: 'pipe' });
    } else {
      logger.info(
        `正在对 Android 设备 (${serial}) 点击 (${x}, ${y}) dp [→ ${px}, ${py} px]...`
      );
      execSync(`${adbPrefix} shell input tap ${px} ${py}`, { stdio: 'pipe' });
    }
    logger.success('点击完成');
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    if (msg.includes('INJECT_EVENTS')) {
      logger.error('Android 点击失败: 设备未开启「USB调试（安全设置）」');
      logger.info('请前往: 设置 → 更多设置 → 开发者选项 → USB调试（安全设置）→ 开启');
    } else {
      logger.error(`Android 点击失败: ${msg}`);
    }
    process.exit(1);
  }
}

/**
 * Android 滑动
 */
function swipeAndroid(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  duration: number,
  serial: string,
): void {
  if (!commandExists('adb')) {
    logger.error('adb 未安装或不在 PATH 中');
    logger.info('请使用 brew install --cask android-platform-tools 安装 adb');
    process.exit(1);
  }

  const adbPrefix = `adb -s ${serial}`;
  const factor = getAndroidDensityFactor(serial);
  const px1 = dpToPx(x1, factor);
  const py1 = dpToPx(y1, factor);
  const px2 = dpToPx(x2, factor);
  const py2 = dpToPx(y2, factor);
  logger.info(
    `正在对 Android 设备 (${serial}) 从 (${x1}, ${y1}) → (${x2}, ${y2}) dp ` +
      `[(${px1}, ${py1}) → (${px2}, ${py2}) px]，持续 ${duration}ms...`
  );

  try {
    execSync(`${adbPrefix} shell input swipe ${px1} ${py1} ${px2} ${py2} ${duration}`, { stdio: 'pipe' });
    logger.success('滑动完成');
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    if (msg.includes('INJECT_EVENTS')) {
      logger.error('Android 滑动失败: 设备未开启「USB调试（安全设置）」');
      logger.info('请前往: 设置 → 更多设置 → 开发者选项 → USB调试（安全设置）→ 开启');
    } else {
      logger.error(`Android 滑动失败: ${msg}`);
    }
    process.exit(1);
  }
}

/**
 * WDA 配置目录与文件
 */
const HEX_CLI_DIR = path.join(os.homedir(), '.hex-cli');
const WDA_BUILD_LOG = path.join(HEX_CLI_DIR, 'wda-build.log');
const IPROXY_LOG = path.join(HEX_CLI_DIR, 'iproxy.log');
const WDA_DERIVED_DATA = path.join(HEX_CLI_DIR, 'wda-derived-data');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB 后截断，防止无限增长

/**
 * WDA 测试运行目标常量。
 * 与 WebDriverAgent/WebDriverAgentRunner/UITestingUITests.m 的 `- (void)testRunner` 强绑定，
 * 改 WDA 时需要同步更新（否则 -only-testing 找不到测试，HTTP server 不会启动）。
 */
const WDA_TEST_TARGET = 'WebDriverAgentRunner';
const WDA_TEST_CLASS = 'UITestingUITests';
const WDA_TEST_METHOD = 'testRunner';
const WDA_ONLY_TESTING_ID = `${WDA_TEST_TARGET}/${WDA_TEST_CLASS}/${WDA_TEST_METHOD}`;

/**
 * 确保 ~/.hex-cli 目录存在
 */
function ensureHexCliDir(): void {
  if (!fs.existsSync(HEX_CLI_DIR)) {
    fs.mkdirSync(HEX_CLI_DIR, { recursive: true });
  }
}

/**
 * 日志文件超过阈值时截断（保留最近 1MB 内容），避免长期使用后日志膨胀。
 */
function rotateLogIfNeeded(file: string): void {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size <= LOG_MAX_BYTES) return;
    const keep = 1 * 1024 * 1024;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, st.size - keep);
    fs.closeSync(fd);
    fs.writeFileSync(file, `\n[hex-cli] log rotated at ${new Date().toISOString()} (was ${st.size} bytes)\n${buf.toString('utf-8')}`);
  } catch {
    // rotate 失败不影响主流程
  }
}

/**
 * 获取 WDA 工程路径
 */
function resolveWDAProjectPath(): string | null {
  const candidates: string[] = [];

  // 1. 优先 ~/.hex-cli/WebDriverAgent/
  candidates.push(path.join(HEX_CLI_DIR, 'WebDriverAgent'));

  // 2. 相对当前文件路径推算到项目根
  //    dist/ 或 src/commands/ 下，向上找到包含 WebDriverAgent 目录
  let cur = __dirname;
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(cur, 'WebDriverAgent'));
    cur = path.dirname(cur);
  }

  for (const dir of candidates) {
    const proj = path.join(dir, 'WebDriverAgent.xcodeproj');
    if (fs.existsSync(proj)) {
      return dir;
    }
  }
  return null;
}


/**
 * 检测当前 iproxy 是否支持新语法（-u UDID LOCAL:DEVICE）。
 * - libusbmuxd 2.x（iproxy 2.x）：只接受 LOCAL_PORT:DEVICE_PORT，老的三位参数会报
 *   “Invalid listen port specified in argument”。
 * - libusbmuxd 1.x：三位参数 LOCAL DEVICE [UDID]，不认 -u。
 */
let _iproxyNewSyntaxCache: boolean | null = null;
function iproxySupportsNewSyntax(): boolean {
  if (_iproxyNewSyntaxCache !== null) return _iproxyNewSyntaxCache;
  try {
    const help = execSync('iproxy --help 2>&1', { encoding: 'utf-8' });
    _iproxyNewSyntaxCache = /-u,?\s*--udid/.test(help) || /LOCAL_PORT:DEVICE_PORT/.test(help);
  } catch {
    _iproxyNewSyntaxCache = false;
  }
  return _iproxyNewSyntaxCache;
}

interface IproxyProc {
  pid: number;
  cmd: string;
  localPort: number | null;
  devicePort: number | null;
  udid: string | null;
}

/**
 * 解析 iproxy cmdline 中的本机端口与设备端口（兼容新/旧语法）。
 * 新语法：iproxy -u UDID localPort:devicePort
 * 旧语法：iproxy localPort devicePort UDID
 *
 * 所有正则都以 \biproxy\s+ 锁定起步，避免 cmd 中包含与 udid 参混的数字串造成错位。
 */
function parseIproxyPorts(cmd: string): { localPort: number | null; devicePort: number | null } {
  // 新语法：在 \biproxy\s+ 之后查找 localPort:devicePort（中间可能夹着 -u UDID）
  const newSyntax = cmd.match(/\biproxy\b[^\n]*?(\d+):(\d+)/);
  if (newSyntax) {
    return { localPort: parseInt(newSyntax[1], 10), devicePort: parseInt(newSyntax[2], 10) };
  }
  // 旧语法：iproxy LOCAL DEVICE [UDID]
  const oldSyntax = cmd.match(/\biproxy\s+(\d+)\s+(\d+)/);
  if (oldSyntax) {
    return { localPort: parseInt(oldSyntax[1], 10), devicePort: parseInt(oldSyntax[2], 10) };
  }
  return { localPort: null, devicePort: null };
}

/**
 * 从 iproxy 命令行中提取 udid（同时兼容新/旧语法）。
 * 识别不出返回 null。
 */
function extractUdidFromIproxyCmd(cmd: string): string | null {
  // 新语法：仅在 \biproxy\b 之后拍 -u/--udid，避免可能的路径变量造成误伤
  const newSyntax = cmd.match(/\biproxy\b[^\n]*?(?:-u|--udid)\s+(\S+)/);
  if (newSyntax) return newSyntax[1];
  // 旧语法：iproxy LOCAL DEVICE UDID（UDID 可选，在末尾）
  const oldSyntax = cmd.match(/\biproxy\s+\d+\s+\d+\s+([\w-]+)/);
  if (oldSyntax) return oldSyntax[1];
  return null;
}

/**
 * 读取所有当前后台运行的 iproxy 进程，按行解析为结构化数据。
 * 排除 grep / pgrep 自身误命中。
 */
function listAllIproxyProcs(): IproxyProc[] {
  try {
    // pgrep -lf 输出: "<pid> <cmdline>"
    const out = execSync('pgrep -lf iproxy', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const result: IproxyProc[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[2];
      // 必须真正是 iproxy（排除 pgrep/grep 自身命中）
      if (!/\biproxy\b/.test(cmd)) continue;
      const { localPort, devicePort } = parseIproxyPorts(cmd);
      const udid = extractUdidFromIproxyCmd(cmd);
      result.push({ pid: parseInt(m[1], 10), cmd, localPort, devicePort, udid });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 检测 iproxy 是否已为该 udid 在期望的本机端口上把设备 8100 转发出来。
 * - true：udid 命中、设备端 8100、本机端口与映射一致
 * - false：未运行 / 转发到错误设备端 / 本机端口不一致 → 需要先 kill 重启
 */
function isIproxyRunningForUdid(udid: string): boolean {
  const expectedPort = getMappedPortForUdid(udid);
  if (expectedPort === null) return false;
  const procs = listAllIproxyProcs();
  return procs.some(
    (p) => p.udid === udid && p.devicePort === 8100 && p.localPort === expectedPort,
  );
}

/**
 * 杀掉所有把设备 8100 转发出来的 iproxy 进程（不限 udid）。
 * 用于 reset --all；不会误伤 8100 之外用途的 iproxy。
 */
function killAllIproxy(): number {
  const procs = listAllIproxyProcs();
  let killed = 0;
  for (const p of procs) {
    if (p.devicePort !== 8100) continue;
    try {
      process.kill(p.pid, 'SIGKILL');
      killed++;
    } catch {
      // 进程可能已退出，忽略
    }
  }
  return killed;
}

/**
 * 仅杀掉为指定 udid 转发设备 8100 的 iproxy 进程。
 */
function killIproxyForUdid(udid: string): number {
  const procs = listAllIproxyProcs();
  let killed = 0;
  for (const p of procs) {
    if (p.udid !== udid) continue;
    if (p.devicePort !== 8100) continue;
    try {
      process.kill(p.pid, 'SIGKILL');
      killed++;
    } catch {
      // 进程可能已退出，忽略
    }
  }
  return killed;
}

/**
 * 后台启动 iproxy，转发本机 8100 到设备 8100。
 * 自动适配 libusbmuxd 1.x / 2.x 两代语法。
 * 启动后会等待 ˜1.2s 复查存活，如果 iproxy 立即退出会读日志尾部报错，不再隐藏问题。
 */
async function startIproxyBackgroundAndVerify(udid: string): Promise<void> {
  if (!commandExists('iproxy')) {
    throw new Error('iproxy 未安装，请先安装：brew install libimobiledevice');
  }
  ensureHexCliDir();
  rotateLogIfNeeded(IPROXY_LOG);
  // 为该 udid 分配/复用本机端口（多设备并发要求每台设备占一个）
  const localPort = await getPortForUdid(udid);
  const out = fs.openSync(IPROXY_LOG, 'a');
  const err = fs.openSync(IPROXY_LOG, 'a');
  const newSyntax = iproxySupportsNewSyntax();
  const args = newSyntax
    ? ['-u', udid, `${localPort}:8100`]   // libusbmuxd 2.x
    : [String(localPort), '8100', udid];  // libusbmuxd 1.x
  logger.debug(`spawn iproxy ${args.join(' ')} (newSyntax=${newSyntax}, udid=${udid}, localPort=${localPort})`);
  const child = spawn('iproxy', args, {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  logger.debug(`iproxy spawned pid=${child.pid}, waiting 1200ms to verify alive`);
  // 等一小会让 iproxy 有机会报错退出
  await new Promise((r) => setTimeout(r, 1200));
  if (!isIproxyRunningForUdid(udid)) {
    let tail = '';
    try {
      const log = fs.readFileSync(IPROXY_LOG, 'utf-8');
      tail = log.split('\n').slice(-15).join('\n').trim();
    } catch {}
    throw new Error(
      `iproxy 启动后立即退出（未能为 UDID ${udid} 在本机 ${localPort} 建立转发）。\n` +
        `详细日志：${IPROXY_LOG}\n\n--- iproxy.log 末 15 行 ---\n${tail}`,
    );
  }
}

/**
 * 查找已编译的 .xctestrun 文件
 */
function findXctestrun(): string | null {
  const productsDir = path.join(WDA_DERIVED_DATA, 'Build', 'Products');
  if (!fs.existsSync(productsDir)) return null;
  try {
    const files = fs.readdirSync(productsDir);
    const xctestrun = files.find((f) => f.endsWith('.xctestrun'));
    if (xctestrun) return path.join(productsDir, xctestrun);
  } catch {}
  return null;
}

/**
 * 从 .xctestrun 文件名中提取编译时的 iOS 主次版本（如 "26.1"）。
 * 文件名格式如：WebDriverAgentRunner_iphoneos26.1-arm64.xctestrun。
 */
function extractIOSVersionFromXctestrun(file: string): string | null {
  const m = path.basename(file).match(/iphoneos([0-9]+(?:\.[0-9]+)?)/i);
  return m ? m[1] : null;
}

/**
 * 获取设备当前 iOS 主次版本（如 "26.1"）。
 * - 使用 xcrun devicectl （Xcode 15+）。
 * - 获取失败返回 null，外层需以“未知”引用、不作为判定依据。
 */
function getDeviceIOSVersion(udid: string): string | null {
  if (!isDevicectlAvailable()) return null;
  try {
    const out = execSync(
      `xcrun devicectl list devices --json-output - 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
    );
    const json = JSON.parse(out);
    const devices: any[] = json?.result?.devices || [];
    const dev = devices.find((d) => d?.hardwareProperties?.udid === udid || d?.identifier === udid);
    const v: string | undefined = dev?.deviceProperties?.osVersionNumber || dev?.deviceProperties?.osVersion;
    if (!v) return null;
    // 只保留 major.minor（忑略 patch）
    const m = v.match(/^(\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 检测 devicectl 是否可用（Xcode 15+）
 */
function isDevicectlAvailable(): boolean {
  try {
    execSync('xcrun devicectl --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查设备上是否已安装 WebDriverAgentRunner
 * 返回 true=已安装；false=未安装；null=无法检测（不应据此判定）
 *
 * 安全：udid 走 execFileSync argv，不过 shell，即使含特殊字符也不会注入。
 */
function isWDAInstalledOnDevice(udid: string): boolean | null {
  if (!isDevicectlAvailable()) return null;
  try {
    const output = execFileSync(
      'xcrun',
      ['devicectl', 'device', 'info', 'apps', '--device', udid],
      {
        encoding: 'utf-8',
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024,
        // 忽略 stderr 等同于原来的 2>/dev/null
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return output.includes('WebDriverAgentRunner');
  } catch {
    return null;
  }
}

/**
 * 编译并安装 WDA（首次完整编译，后续 xcodebuild 自动增量）
 * 跳过条件：本地有 .xctestrun + 编译时 iOS 版本与设备一致 + 设备上已安装 WDA。
 */
function buildWDAIfNeeded(wdaPath: string, udid: string): void {
  const xctestrun = findXctestrun();
  const installed = isWDAInstalledOnDevice(udid);
  logger.debug(`buildWDAIfNeeded: xctestrun=${xctestrun || 'none'} installed=${installed}`);

  // iOS 版本漂移检测：设备升级后旧 .xctestrun 可能不兼容，需重编。
  let versionMismatch = false;
  if (xctestrun) {
    const builtVer = extractIOSVersionFromXctestrun(xctestrun);
    const deviceVer = getDeviceIOSVersion(udid);
    if (builtVer && deviceVer && builtVer !== deviceVer) {
      logger.info(`检测到 WDA 编译产物 iOS ${builtVer} 与设备当前 iOS ${deviceVer} 不一致，将重新编译`);
      versionMismatch = true;
    }
  }

  if (xctestrun && !versionMismatch && installed === true) {
    logger.info('已有 WDA 编译产物且设备已安装，跳过编译');
    return;
  }
  if (xctestrun && !versionMismatch && installed === null) {
    logger.info('已有 WDA 编译产物，跳过编译（未能验证设备安装状态）');
    return;
  }

  if (versionMismatch) {
    // 同时清除产物目录以避免多个 iOS 版本的 .xctestrun 并存干扰后续查找
    try {
      const productsDir = path.join(WDA_DERIVED_DATA, 'Build', 'Products');
      if (fs.existsSync(productsDir)) {
        for (const f of fs.readdirSync(productsDir)) {
          if (f.endsWith('.xctestrun')) {
            fs.rmSync(path.join(productsDir, f));
          }
        }
      }
    } catch {}
    logger.info('重新编译 WDA（适配设备当前 iOS 版本）...');
  } else if (xctestrun && installed === false) {
    logger.info('检测到设备未安装 WDA，执行增量编译并重新安装...');
  } else {
    logger.info('首次使用，正在编译 WDA（可能需要 1-3 分钟）...');
  }
  logger.info(`编译日志: ${WDA_BUILD_LOG}`);

  const args = [
    'build-for-testing',
    '-project',
    path.join(wdaPath, 'WebDriverAgent.xcodeproj'),
    '-scheme',
    WDA_TEST_TARGET,
    '-destination',
    `id=${udid}`,
    '-derivedDataPath',
    WDA_DERIVED_DATA,
    '-allowProvisioningUpdates',
  ];

  ensureHexCliDir();
  rotateLogIfNeeded(WDA_BUILD_LOG);
  fs.appendFileSync(
    WDA_BUILD_LOG,
    `\n\n===== ${new Date().toISOString()} build-for-testing =====\n` +
      `wdaPath=${wdaPath}\nudid=${udid}\n`
  );
  logger.debug(`xcodebuild ${args.join(' ')}`);

  const buildStart = Date.now();
  try {
    execSync(`xcodebuild ${args.map((a) => `"${a}"`).join(' ')} >> "${WDA_BUILD_LOG}" 2>&1`, {
      stdio: 'pipe',
      timeout: 300000, // 5 分钟超时
    });
    logger.debug(`xcodebuild build-for-testing succeeded in ${Date.now() - buildStart}ms`);
    logger.success('WDA 编译完成');
  } catch (err: any) {
    logger.debug(`xcodebuild build-for-testing failed in ${Date.now() - buildStart}ms: ${err?.message}`);
    logger.error('WDA 编译失败，请查看日志: ' + WDA_BUILD_LOG);
    process.exit(1);
  }
}

/**
 * 后台启动 WDA（使用预编译产物，无需重新编译）
 */
function startWDATestBackground(udid: string): void {
  const xctestrun = findXctestrun();
  if (!xctestrun) {
    throw new Error('未找到 WDA 编译产物 (.xctestrun)');
  }

  ensureHexCliDir();
  rotateLogIfNeeded(WDA_BUILD_LOG);
  const out = fs.openSync(WDA_BUILD_LOG, 'a');
  const err = fs.openSync(WDA_BUILD_LOG, 'a');
  fs.appendFileSync(
    WDA_BUILD_LOG,
    `\n\n===== ${new Date().toISOString()} test-without-building =====\n` +
      `xctestrun=${xctestrun}\nudid=${udid}\n`
  );

  const args = [
    'test-without-building',
    '-xctestrun',
    xctestrun,
    '-destination',
    `id=${udid}`,
    '-derivedDataPath',
    WDA_DERIVED_DATA,
    // Xcode 16+ 在没有 OnlyTestIdentifiers 时会自动发现 0 个测试，
    // 必须显式指定到 WDA 的 testRunner 死循环方法，HTTP server 才会启动
    `-only-testing:${WDA_ONLY_TESTING_ID}`,
  ];

  logger.debug(`spawn xcodebuild ${args.join(' ')}`);
  const child = spawn('xcodebuild', args, {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  logger.debug(`xcodebuild spawned pid=${child.pid}`);
}

/**
 * 自动部署并确保 WDA 可用（使用上层已选定的目标设备 UDID）。
 *
 * 多设备并发模型：
 *   - 每台 iOS 设备独占一个本机端口（见 wda-ports.ts），互不干扰
 *   - 仅清理本 udid 的 iproxy 残留，保留其它设备的 iproxy 不动
 */
async function ensureWDA(udid: string): Promise<void> {
  logger.debug(`ensureWDA enter: udid=${udid}`);
  // 0. 已运行 → 直接返回
  //    必须同时确认 iproxy 当前正在为目标 UDID 转发到记录的本机端口，
  //    且 WDA /status 可达，否则可能命中其它设备或服务尚未就绪。
  const iproxyOk = isIproxyRunningForUdid(udid);
  const wdaOk = iproxyOk ? await checkWDA(udid) : false;
  logger.debug(`ensureWDA stage0: iproxyOk=${iproxyOk} wdaOk=${wdaOk}`);
  if (iproxyOk && wdaOk) {
    return;
  }

  logger.info('未检测到 WDA 服务，开始自动部署...');
  logger.info(`目标 iOS 设备 UDID: ${udid}`);

  // 2. 启动 iproxy（仅清理本 udid 的旧进程，不动其它设备）
  if (isIproxyRunningForUdid(udid)) {
    logger.info('iproxy 已在为当前 UDID 转发');
  } else {
    // 本 udid 可能有端口漂移的旧 iproxy 残留（例如映射文件被改过），先清
    const killed = killIproxyForUdid(udid);
    if (killed > 0) {
      logger.info(`清理 ${udid} 的旧 iproxy 进程：${killed} 个`);
      await new Promise((r) => setTimeout(r, 300));
    }
    logger.info('启动 iproxy 转发...');
    try {
      await startIproxyBackgroundAndVerify(udid);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  }

  // 3. 再次检测 WDA（端口转发后可能就通了）
  if (await checkWDA(udid)) {
    logger.success('WDA 已就绪');
    return;
  }

  // 4. 准备 WDA 工程路径
  const wdaPath = resolveWDAProjectPath();
  if (!wdaPath) {
    logger.error('未找到 WebDriverAgent 工程目录');
    logger.info(`请确认 ${path.join(HEX_CLI_DIR, 'WebDriverAgent')} 或项目根目录下存在 WebDriverAgent/`);
    process.exit(1);
  }
  logger.info(`使用 WDA 工程: ${wdaPath}`);

  // 5. 编译 WDA（仅首次，后续跳过）
  buildWDAIfNeeded(wdaPath, udid);

  // 7. 后台启动 WDA test runner（使用预编译产物）
  logger.info('正在启动 WDA...');
  try {
    startWDATestBackground(udid);
  } catch (err: any) {
    logger.error(`启动 WDA 失败: ${err.message}`);
    process.exit(1);
  }

  // 8. 轮询等待 WDA 就绪（首次启动 + iOS 26 在边界超 30s，预留 60s）
  const totalTimeoutMs = 60000;
  const intervalMs = 2000;
  logger.info(`等待 WDA 就绪（最多 ${totalTimeoutMs / 1000} 秒）...`);
  const start = Date.now();
  let ready = false;
  let lastTick = start;
  while (Date.now() - start < totalTimeoutMs) {
    if (await checkWDA(udid)) {
      ready = true;
      break;
    }
    // 每 10s 输出一次进度，避免用户以为卡住
    if (Date.now() - lastTick >= 10000) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      logger.info(`仍在等待... ${elapsed}s / ${totalTimeoutMs / 1000}s`);
      lastTick = Date.now();
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  logger.debug(`ensureWDA wait result: ready=${ready} elapsed=${Date.now() - start}ms`);
  if (!ready) {
    logger.error('WDA 启动后仍无法连接 (http://127.0.0.1:8100/status)');
    logger.info(`请查看日志: ${WDA_BUILD_LOG}`);
    logger.info('常见原因：');
    logger.info('  - 设备未信任此电脑：');
    logger.info('      1）保持 USB 连接，解锁设备');
    logger.info('      2）设备上出现“信任此电脑”弹窗 → 点击信任 → 输入锁屏密码');
    logger.info('      3）若未弹窗：设置 → 通用 → 传输或重置 iPhone → 重置 → 重置位置与隐私，重插 USB');
    logger.info('  - 首次部署需要在设备上信任开发者证书（设置 → 通用 → VPN 与设备管理）');
    logger.info('  - 所有状态一键重置：hex tap reset');
    process.exit(1);
  }
  logger.success('WDA 已就绪');
}

/**
 * 输出 WDA 未部署的引导信息（保留兼容）
 */
function printWDAUsageGuide(): void {
  logger.info('');
  logger.info('iOS 真机点击/滑动需要 WDA (WebDriverAgent) 在设备上运行');
  logger.info('');
  logger.info('部署步骤：');
  logger.info('  1. 用 Xcode 打开项目目录中的 WebDriverAgent:');
  logger.info('     open ~/.hex-cli/WebDriverAgent/WebDriverAgent.xcodeproj');
  logger.info('  2. 选择 WebDriverAgentRunner scheme，Target 选择真机');
  logger.info('  3. 配置 Signing Team（使用你的 Apple 开发者账号）');
  logger.info('  4. Product → Test（⌘U）将 WDA 安装并运行到真机');
  logger.info('  5. 转发端口: iproxy 8100 8100');
  logger.info('  6. 验证: curl http://127.0.0.1:8100/status');
  logger.info('');
}

/**
 * iOS 点击
 */
async function tapIOS(x: number, y: number, duration: number | undefined, udid: string): Promise<void> {
  await ensureWDA(udid);

  let sessionId: string;
  try {
    sessionId = await getOrCreateSession(udid);
  } catch (err: any) {
    logger.error(`获取 WDA session 失败: ${err.message}`);
    process.exit(1);
  }

  try {
    if (duration && duration > 0) {
      logger.info(`正在对 iOS 设备在 (${x}, ${y}) 长按 ${duration}ms...`);
      // WDA 长按使用 touchAndHold，duration 单位为秒
      await wdaRequest(
        udid,
        'POST',
        `/session/${sessionId}/wda/touchAndHold`,
        { x, y, duration: duration / 1000 },
        Math.max(15000, duration + 5000)
      );
    } else {
      logger.info(`正在对 iOS 设备点击 (${x}, ${y})...`);
      await wdaRequest(udid, 'POST', `/session/${sessionId}/wda/tap`, { x, y }, 10000);
    }
    logger.success('点击完成');
  } catch (err: any) {
    logger.error(`iOS 点击失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * iOS 滑动
 */
async function swipeIOS(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  duration: number,
  udid: string,
): Promise<void> {
  await ensureWDA(udid);

  let sessionId: string;
  try {
    sessionId = await getOrCreateSession(udid);
  } catch (err: any) {
    logger.error(`获取 WDA session 失败: ${err.message}`);
    process.exit(1);
  }

  logger.info(`正在对 iOS 设备从 (${x1}, ${y1}) 滑动到 (${x2}, ${y2})，持续 ${duration}ms...`);

  try {
    // 计算距离和速度（velocity = pixels/sec）
    const distance = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    const velocity = distance / (duration / 1000); // 像素/秒

    await wdaRequest(
      udid,
      'POST',
      `/session/${sessionId}/wda/pressAndDragWithVelocity`,
      {
        fromX: x1,
        fromY: y1,
        toX: x2,
        toY: y2,
        pressDuration: 0,
        velocity: Math.max(velocity, 100),
        holdDuration: 0,
      },
      Math.max(15000, duration + 5000)
    );
    logger.success('滑动完成');
  } catch (err: any) {
    logger.error(`iOS 滑动失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * 清理本机 WDA 相关残留：iproxy 进程、xcodebuild 测试进程、过期 .xctestrun 、wda-ports.json 映射。
 * 用于设备升级 iOS、切换设备、或 WDA 卡死时一键复位。
 */
async function resetWDAArtifactsAll(): Promise<void> {
  // 1. 杀 iproxy（所有转发设备 8100 的）
  const killedIproxy = killAllIproxy();
  logger.info(`已清理 iproxy 进程：${killedIproxy} 个`);

  // 2. 杀 xcodebuild test runner（仅匹配本工具启动的：test-without-building / WebDriverAgentRunner）
  let killedXcb = 0;
  try {
    const out = execSync('pgrep -lf xcodebuild', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[2];
      if (!/test-without-building|WebDriverAgent/.test(cmd)) continue;
      try {
        process.kill(parseInt(m[1], 10), 'SIGKILL');
        killedXcb++;
      } catch {}
    }
  } catch {}
  logger.info(`已清理 xcodebuild WDA 进程：${killedXcb} 个`);

  // 3. 删除 .xctestrun 产物（保留 derivedData 其它内容，重编不必从零开始）
  let removedRun = 0;
  try {
    const productsDir = path.join(WDA_DERIVED_DATA, 'Build', 'Products');
    if (fs.existsSync(productsDir)) {
      for (const f of fs.readdirSync(productsDir)) {
        if (f.endsWith('.xctestrun')) {
          fs.rmSync(path.join(productsDir, f));
          removedRun++;
        }
      }
    }
  } catch (err: any) {
    logger.error(`清理 .xctestrun 失败：${err.message}`);
  }
  logger.info(`已删除 .xctestrun 文件：${removedRun} 个`);

  // 4. 清空端口映射（下次会重新分配）
  try {
    await clearAllPorts();
    logger.info('已清空 wda-ports.json 映射');
  } catch (err: any) {
    logger.warn(`清空端口映射失败：${err.message}`);
  }

  logger.success('WDA 状态已全部重置，下次执行 hex tap 将重新部署');
}

/**
 * 仅重置指定设备的 WDA 状态：
 *   - 杀该 udid 的 iproxy
 *   - 杀该 udid 的 xcodebuild test runner（按 -destination id=<udid> 匹配）
 *   - 释放本机端口映射
 * 不动其它设备、不动 .xctestrun（多设备共享产物）。
 */
async function resetWDAArtifactsForUdid(udid: string): Promise<void> {
  // 1. 杀本 udid 的 iproxy
  const killedIproxy = killIproxyForUdid(udid);
  logger.info(`已清理 udid=${udid} 的 iproxy 进程：${killedIproxy} 个`);

  // 2. 杀本 udid 的 xcodebuild test runner
  //    同时要求命令行同时含 WebDriverAgent / test-without-building，避免误伤用户的其它测试。
  let killedXcb = 0;
  try {
    const out = execSync('pgrep -lf xcodebuild', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[2];
      if (!/test-without-building|WebDriverAgent/.test(cmd)) continue;
      if (!cmd.includes(`id=${udid}`)) continue;
      try {
        process.kill(parseInt(m[1], 10), 'SIGKILL');
        killedXcb++;
      } catch {}
    }
  } catch {}
  logger.info(`已清理 udid=${udid} 的 xcodebuild WDA 进程：${killedXcb} 个`);

  // 3. 释放本机端口映射
  try {
    await releasePortForUdid(udid);
    logger.info(`已释放 ${udid} 的本机端口映射`);
  } catch (err: any) {
    logger.warn(`释放端口映射失败：${err.message}`);
  }

  logger.success(`已重置设备 ${udid} 的 WDA 状态，下次执行 hex tap --udid ${udid} 将重新部署`);
}

/**
 * iOS 按文本点击
 */
async function tapIOSByText(text: string, exact: boolean, index: number, udid: string): Promise<void> {
  await ensureWDA(udid);

  let sessionId: string;
  try {
    sessionId = await getOrCreateSession(udid);
  } catch (err: any) {
    logger.error(`获取 WDA session 失败: ${err.message}`);
    process.exit(1);
  }

  // 构建 NSPredicate 查询
  const op = exact ? '==' : 'CONTAINS[cd]';
  const escaped = text.replace(/'/g, "\\'");
  const predicate = `label ${op} '${escaped}' OR value ${op} '${escaped}'`;

  try {
    logger.info(`正在查找文本「${text}」(${exact ? '精确' : '模糊'}匹配)...`);
    const res = await wdaRequest(
      udid,
      'POST',
      `/session/${sessionId}/elements`,
      { using: 'predicate string', value: predicate },
      15000,
    );

    const elements: any[] = res.value || [];
    if (elements.length === 0) {
      logger.error(`未找到包含文本「${text}」的元素`);
      process.exit(1);
    }
    if (elements.length > 1) {
      logger.warn(`找到 ${elements.length} 个匹配元素，将点击第 ${index} 个`);
    }
    if (index > elements.length) {
      logger.error(`--index ${index} 超出匹配数量 (共 ${elements.length} 个)`);
      process.exit(1);
    }

    const target = elements[index - 1];
    const uuid = target.ELEMENT || target['element-6066-11e4-a52e-4f735466cecf'];
    if (!uuid) {
      logger.error('元素 UUID 解析失败');
      process.exit(1);
    }

    logger.info(`正在点击元素 [${index}/${elements.length}]...`);
    await wdaRequest(udid, 'POST', `/session/${sessionId}/element/${uuid}/click`, {}, 10000);
    logger.success('点击完成');
  } catch (err: any) {
    logger.error(`iOS 按文本点击失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Android 按文本点击
 */
function tapAndroidByText(text: string, exact: boolean, index: number, serial: string): void {
  if (!commandExists('adb')) {
    logger.error('adb 未安装或不在 PATH 中');
    process.exit(1);
  }

  logger.info(`正在获取 Android 视图树...`);
  let xml: string;
  try {
    xml = execSync(
      `adb -s ${serial} shell "uiautomator dump /sdcard/hex_ui_dump.xml && cat /sdcard/hex_ui_dump.xml && rm -f /sdcard/hex_ui_dump.xml"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    );
  } catch (err: any) {
    logger.error(`uiautomator dump 失败: ${err.message}`);
    process.exit(1);
  }

  // 用正则匹配所有 node 的 text / content-desc / bounds
  const nodeRegex = /<node[^>]*>/g;
  const matches: Array<{ matchedText: string; bounds: string }> = [];
  let m: RegExpExecArray | null;

  while ((m = nodeRegex.exec(xml)) !== null) {
    const nodeStr = m[0];
    const textAttr = nodeStr.match(/\btext="([^"]*)"/)?.[1] || '';
    const descAttr = nodeStr.match(/\bcontent-desc="([^"]*)"/)?.[1] || '';
    const boundsAttr = nodeStr.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsAttr) continue;

    const displayText = textAttr || descAttr;
    if (!displayText) continue;

    const matched = exact
      ? displayText === text
      : displayText.toLowerCase().includes(text.toLowerCase());
    if (matched) {
      matches.push({ matchedText: displayText, bounds: boundsAttr[0] });
    }
  }

  if (matches.length === 0) {
    logger.error(`未找到包含文本「${text}」的元素`);
    process.exit(1);
  }
  if (matches.length > 1) {
    logger.warn(`找到 ${matches.length} 个匹配元素，将点击第 ${index} 个`);
  }
  if (index > matches.length) {
    logger.error(`--index ${index} 超出匹配数量 (共 ${matches.length} 个)`);
    process.exit(1);
  }

  const chosen = matches[index - 1];
  const boundsMatch = chosen.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!boundsMatch) {
    logger.error('bounds 解析失败');
    process.exit(1);
  }
  const [, x1s, y1s, x2s, y2s] = boundsMatch;
  const cx = Math.round((Number(x1s) + Number(x2s)) / 2);
  const cy = Math.round((Number(y1s) + Number(y2s)) / 2);

  logger.info(`正在点击「${chosen.matchedText}」中心坐标 (${cx}, ${cy}) px [${index}/${matches.length}]...`);
  try {
    execSync(`adb -s ${serial} shell input tap ${cx} ${cy}`, { stdio: 'pipe' });
    logger.success('点击完成');
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    if (msg.includes('INJECT_EVENTS')) {
      logger.error('Android 点击失败: 设备未开启「USB调试（安全设置）」');
      logger.info('请前往: 设置 → 更多设置 → 开发者选项 → USB调试（安全设置）→ 开启');
    } else {
      logger.error(`Android 点击失败: ${msg}`);
    }
    process.exit(1);
  }
}

/**
 * HarmonyOS 按文本点击（通过 uitest dumpLayout 查找元素 + uitest click）
 */
function tapHarmonyByText(text: string, exact: boolean, index: number, udid: string): void {
  logger.info(`正在获取 HarmonyOS 视图树...`);
  let root;
  try {
    root = dumpHarmonyLayout(udid);
  } catch (err: any) {
    logger.error(`获取 HarmonyOS 视图树失败: ${err.message}`);
    process.exit(1);
  }

  const matches = findNodesByText(root, text, exact);
  if (matches.length === 0) {
    logger.error(`未找到包含文本「${text}」的元素`);
    process.exit(1);
  }
  if (matches.length > 1) {
    logger.warn(`找到 ${matches.length} 个匹配元素，将点击第 ${index} 个`);
  }
  if (index > matches.length) {
    logger.error(`--index ${index} 超出匹配数量 (共 ${matches.length} 个)`);
    process.exit(1);
  }

  const chosen = matches[index - 1];
  const bounds = parseBounds(chosen.attributes.bounds || '');
  if (!bounds) {
    logger.error('目标元素 bounds 解析失败');
    process.exit(1);
  }
  const cx = Math.round((bounds.x1 + bounds.x2) / 2);
  const cy = Math.round((bounds.y1 + bounds.y2) / 2);

  logger.info(`正在点击「${chosen.attributes.text || chosen.attributes.description}」中心坐标 (${cx}, ${cy}) px [${index}/${matches.length}]...`);
  try {
    execSync(`hdc -t ${udid} shell uitest uiInput click ${cx} ${cy}`, { stdio: 'pipe', timeout: 10000 });
    logger.success('点击完成');
  } catch (err: any) {
    logger.error(`HarmonyOS 点击失败: ${err.message}`);
    process.exit(1);
  }
}

const tap = new Command('tap')
  .description('在连接的设备指定坐标点击（支持长按）。坐标单位：iOS 为 pt、Android 为 dp、HarmonyOS 为 vp（跨平台一致）')
  .option('-x <x>', '点击 X 坐标（pt/dp/vp）')
  .option('-y <y>', '点击 Y 坐标（pt/dp/vp）')
  .option('--text <text>', '按文本内容查找并点击元素（与 -x/-y 互斥）')
  .option('--exact', '精确匹配文本（默认模糊 CONTAINS）')
  .option('--index <n>', '匹配多个元素时点击第 n 个（默认 1）', '1')
  .option('--udid <udid>', '指定设备 UDID/Serial（多设备必填）')
  .option('--duration <ms>', '长按持续时间（毫秒），不传则为普通点击')
  .action(async (options) => {
    let target: LocalDevice;
    try {
      target = resolveLocalTarget(options.udid ?? getGlobalUdid());
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
    logger.info(`目标设备: ${target.platform}·${target.name} (${target.udid})`);

    // --text 模式：按文本点击
    if (options.text) {
      const idx = Math.max(1, Math.floor(Number(options.index) || 1));
      if (target.platform === 'android') {
        tapAndroidByText(options.text, !!options.exact, idx, target.udid);
      } else if (target.platform === 'harmonyos') {
        tapHarmonyByText(options.text, !!options.exact, idx, target.udid);
      } else {
        await tapIOSByText(options.text, !!options.exact, idx, target.udid);
      }
      return;
    }

    // 坐标模式
    if (options.x === undefined || options.y === undefined) {
      logger.error('-x 与 -y 为必填项（或使用 --text 按文本点击）');
      logger.info('用法：hex tap -x <x> -y <y> [--duration <ms>]');
      logger.info('      hex tap --text "文本" [--exact] [--index <n>]');
      logger.info('或：  hex tap reset    清理 WDA / iproxy / xctestrun 残留');
      process.exit(1);
    }
    const x = parseNumber(options.x, '-x');
    const y = parseNumber(options.y, '-y');
    const duration = options.duration ? parseNumber(options.duration, '--duration') : undefined;
    warnIfOutOfBounds([[x, y]], target);

    if (target.platform === 'android') {
      tapAndroid(x, y, duration, target.udid);
    } else if (target.platform === 'harmonyos') {
      tapHarmonyOS(x, y, duration, target.udid);
    } else {
      await tapIOS(x, y, duration, target.udid);
    }
  });

tap
  .command('reset')
  .description('清理 WDA / iproxy / xctestrun / 端口映射残留（设备升级、切换设备或 WDA 卡死时使用）')
  .option('--udid <udid>', '仅重置指定设备的 iproxy 与端口映射（不动 .xctestrun 与其它设备）')
  .option('--all', '重置全部：所有 iproxy / xcodebuild / .xctestrun / 端口映射（默认）')
  .action(async (options) => {
    // commander 中顶层 --udid 会被 program 吃掉，子命令拿不到；
    // 这里同时读子命令 options.udid 和 getGlobalUdid() 作为兼容。
    const targetUdid = options.udid || getGlobalUdid();
    if (targetUdid) {
      try {
        assertSafeUdid(targetUdid);
      } catch (err: any) {
        logger.error(err.message);
        process.exit(1);
      }
      await resetWDAArtifactsForUdid(targetUdid);
    } else {
      // 默认为 --all，保持向后兼容
      await resetWDAArtifactsAll();
    }
  });

const swipe = new Command('swipe')
  .description('在连接的设备进行滑动操作。坐标单位：iOS 为 pt、Android 为 dp、HarmonyOS 为 vp（跨平台一致）')
  .option('-x <x>', '起点 X 坐标（pt/dp/vp）')
  .option('-y <y>', '起点 Y 坐标（pt/dp/vp）')
  .option('--x2 <x2>', '终点 X 坐标（pt/dp/vp）')
  .option('--y2 <y2>', '终点 Y 坐标（pt/dp/vp）')
  .option('--from <from>', '起点坐标，格式: x,y（pt/dp/vp）')
  .option('--to <to>', '终点坐标，格式: x,y（pt/dp/vp）')
  .option('--udid <udid>', '指定设备 UDID/Serial（多设备必填）')
  .option('--duration <ms>', '滑动持续时间（毫秒）', '500')
  .action(async (options) => {
    let x1: number, y1: number, x2: number, y2: number;

    if (options.from && options.to) {
      const fromParts = options.from.split(',');
      const toParts = options.to.split(',');
      if (fromParts.length !== 2 || toParts.length !== 2) {
        logger.error('坐标格式错误，正确格式: --from x,y --to x,y');
        process.exit(1);
      }
      x1 = parseNumber(fromParts[0].trim(), '--from x');
      y1 = parseNumber(fromParts[1].trim(), '--from y');
      x2 = parseNumber(toParts[0].trim(), '--to x');
      y2 = parseNumber(toParts[1].trim(), '--to y');
    } else if (options.x && options.y && options.x2 && options.y2) {
      x1 = parseNumber(options.x, '-x');
      y1 = parseNumber(options.y, '-y');
      x2 = parseNumber(options.x2, '--x2');
      y2 = parseNumber(options.y2, '--y2');
    } else {
      logger.error('请指定坐标：--from x,y --to x,y 或 -x <x> -y <y> --x2 <x2> --y2 <y2>');
      process.exit(1);
    }

    const duration = parseNumber(options.duration, '--duration');

    let target: LocalDevice;
    try {
      target = resolveLocalTarget(options.udid ?? getGlobalUdid());
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
    logger.info(`目标设备: ${target.platform}·${target.name} (${target.udid})`);
    warnIfOutOfBounds([[x1, y1], [x2, y2]], target);

    if (target.platform === 'android') {
      swipeAndroid(x1, y1, x2, y2, duration, target.udid);
    } else if (target.platform === 'harmonyos') {
      swipeHarmonyOS(x1, y1, x2, y2, duration, target.udid);
    } else {
      await swipeIOS(x1, y1, x2, y2, duration, target.udid);
    }
  });

export { tap, swipe, ensureWDA };
export default tap;
