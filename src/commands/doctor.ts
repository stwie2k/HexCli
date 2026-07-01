import { Command } from 'commander';
import { execSync } from 'child_process';
import * as logger from '../utils/logger.js';
import { DEFAULT_HARMONYOS_BUNDLE_ID } from '../utils/constants.js';

type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string[];
}

interface Ctx {
  androidSerial: string | null;
  iosUdid: string | null;
  harmonyosUdid: string | null;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function tryExec(cmd: string, timeoutMs = 5000): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim();
  } catch {
    return null;
  }
}

function detectAndroidSerial(): string | null {
  const out = tryExec('adb devices 2>/dev/null', 3000);
  if (!out) return null;
  for (const line of out.split('\n').slice(1)) {
    if (line.trim() && line.includes('\tdevice')) {
      return line.split('\t')[0].trim();
    }
  }
  return null;
}

function detectIosUdid(): string | null {
  const out = tryExec('xcrun xctrace list devices 2>/dev/null', 5000);
  if (!out) return null;
  const section = out.split('== Devices ==')[1]?.split(/==\s/)[0] || '';
  for (const line of section.split('\n')) {
    const m = line.match(/\(\d+\.\d+(?:\.\d+)?\)\s+\(([0-9A-Fa-f-]+)\)/);
    if (m) return m[1];
  }
  return null;
}

function detectHarmonyosUdid(): string | null {
  const out = tryExec('hdc list targets 2>/dev/null', 3000);
  if (!out) return null;
  for (const line of out.split('\n')) {
    const udid = line.trim();
    if (udid && udid !== '[Empty]') return udid;
  }
  return null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ===== 通用 =====

function checkGeneral(): CheckResult[] {
  const results: CheckResult[] = [];

  const nodeVer = process.version.replace(/^v/, '');
  const nodeOk = compareSemver(nodeVer, '18.0.0') >= 0;
  results.push({
    name: 'Node.js >= 18',
    status: nodeOk ? 'ok' : 'fail',
    detail: process.version,
    fix: nodeOk
      ? undefined
      : ['推荐通过 nvm 安装高版本 Node：', '  brew install nvm && nvm install 20', '或：brew install node'],
  });

  results.push({
    name: 'curl 可用',
    status: commandExists('curl') ? 'ok' : 'fail',
    detail: commandExists('curl') ? tryExec('curl --version | head -1', 3000) || '已安装' : '未找到',
    fix: commandExists('curl') ? undefined : ['macOS 通常自带 curl；如缺失：brew install curl'],
  });

  return results;
}

// ===== Android =====

function checkAndroid(ctx: Ctx): CheckResult[] {
  const results: CheckResult[] = [];

  const adbPresent = commandExists('adb');
  const adbVer = adbPresent ? tryExec('adb version 2>/dev/null | head -1', 3000) : null;
  results.push({
    name: 'adb 已安装',
    status: adbPresent ? 'ok' : 'fail',
    detail: adbVer || (adbPresent ? '已安装' : '未找到'),
    fix: adbPresent ? undefined : ['brew install --cask android-platform-tools'],
  });

  if (!adbPresent) {
    results.push({
      name: 'Android 设备已授权',
      status: 'skip',
      detail: '需要先安装 adb',
    });
    return results;
  }

  const adbDevicesRaw = tryExec('adb devices 2>/dev/null', 3000) || '';
  const lines = adbDevicesRaw.split('\n').slice(1).filter((l) => l.trim());
  const authorized = lines.filter((l) => l.includes('\tdevice'));
  const unauthorized = lines.filter((l) => l.includes('\tunauthorized'));
  const offline = lines.filter((l) => l.includes('\toffline'));

  if (authorized.length > 0) {
    results.push({
      name: 'Android 设备已授权',
      status: 'ok',
      detail: `${authorized.length} 台设备 (${ctx.androidSerial})`,
    });
  } else if (unauthorized.length > 0) {
    results.push({
      name: 'Android 设备已授权',
      status: 'fail',
      detail: `${unauthorized.length} 台设备状态为 unauthorized`,
      fix: [
        '在手机屏幕上勾选「始终允许」并点击确认 USB 调试',
        '若依然不弹窗：拔插数据线，或 adb kill-server && adb start-server',
      ],
    });
  } else if (offline.length > 0) {
    results.push({
      name: 'Android 设备已授权',
      status: 'fail',
      detail: `${offline.length} 台设备状态为 offline`,
      fix: ['adb kill-server && adb start-server', '检查数据线是否支持数据传输（部分线只能充电）'],
    });
  } else {
    results.push({
      name: 'Android 设备已连接',
      status: 'skip',
      detail: '未检测到任何 Android 设备（如不需要可忽略）',
    });
  }

  return results;
}

// ===== iOS =====

function checkIos(ctx: Ctx): CheckResult[] {
  const results: CheckResult[] = [];

  const xcSelectPath = tryExec('xcode-select -p 2>/dev/null', 3000);
  if (xcSelectPath && /Xcode\.app/.test(xcSelectPath)) {
    results.push({ name: 'Xcode 活动开发目录', status: 'ok', detail: xcSelectPath });
  } else if (xcSelectPath) {
    results.push({
      name: 'Xcode 活动开发目录',
      status: 'fail',
      detail: `当前指向 ${xcSelectPath}（非完整 Xcode）`,
      fix: ['sudo xcode-select -s /Applications/Xcode.app/Contents/Developer'],
    });
  } else {
    results.push({
      name: 'Xcode 活动开发目录',
      status: 'fail',
      detail: '未配置 xcode-select',
      fix: [
        '从 App Store 安装 Xcode',
        'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
        'xcode-select --install',
      ],
    });
  }

  results.push({
    name: 'xcrun 可用',
    status: commandExists('xcrun') ? 'ok' : 'fail',
    fix: commandExists('xcrun') ? undefined : ['安装 Xcode 或：xcode-select --install'],
  });

  const xcodebuildVer = tryExec('xcodebuild -version 2>/dev/null | head -1', 5000);
  results.push({
    name: 'xcodebuild 可用',
    status: xcodebuildVer ? 'ok' : 'fail',
    detail: xcodebuildVer || '未找到',
    fix: xcodebuildVer ? undefined : ['从 App Store 安装 Xcode 并运行一次同意许可'],
  });

  const devicectlPath = tryExec('xcrun --find devicectl 2>/dev/null', 3000);
  results.push({
    name: 'xcrun devicectl 可用',
    status: devicectlPath ? 'ok' : 'fail',
    detail: devicectlPath || '未找到',
    fix: devicectlPath
      ? undefined
      : [
          'iOS 设备管理需要 Xcode 15+（推荐 26.0+）',
          '从 App Store 安装/升级 Xcode',
          'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
          'xcode-select --install',
        ],
  });

  const xctracePath = tryExec('xcrun --find xctrace 2>/dev/null', 3000);
  results.push({
    name: 'xcrun xctrace 可用',
    status: xctracePath ? 'ok' : 'fail',
    detail: xctracePath || '未找到',
    fix: xctracePath ? undefined : ['安装 Xcode'],
  });

  const pymVerRaw = tryExec('pymobiledevice3 version 2>/dev/null', 5000);
  if (!pymVerRaw) {
    results.push({
      name: 'pymobiledevice3 已安装',
      status: 'fail',
      detail: '未找到',
      fix: [
        'brew install pipx',
        'pipx ensurepath',
        'pipx install pymobiledevice3',
        '安装完成后重开终端确保 PATH 生效',
      ],
    });
  } else {
    const m = pymVerRaw.match(/(\d+\.\d+(?:\.\d+)?)/);
    const ver = m ? m[1] : pymVerRaw;
    const verOk = m ? compareSemver(ver, '4.0.0') >= 0 : false;
    results.push({
      name: 'pymobiledevice3 版本 ≥ 4.0',
      status: verOk ? 'ok' : 'fail',
      detail: ver,
      fix: verOk ? undefined : ['pipx upgrade pymobiledevice3'],
    });
  }

  results.push({
    name: 'iproxy 已安装',
    status: commandExists('iproxy') ? 'ok' : 'fail',
    detail: commandExists('iproxy') ? '已安装' : '未找到',
    fix: commandExists('iproxy') ? undefined : ['brew install libimobiledevice'],
  });

  // ===== 与设备相关的检查 =====

  if (!ctx.iosUdid) {
    results.push({
      name: 'iOS 设备已连接',
      status: 'skip',
      detail: '未检测到 iOS 真机（如不需要可忽略）',
    });
    for (const name of ['开发者模式已开启', 'Developer Disk Image 已挂载', 'tunneld 注册表包含设备', 'WDA 安装在设备上']) {
      results.push({ name, status: 'skip', detail: '需要先连接 iOS 设备' });
    }
    return results;
  }

  const udid = ctx.iosUdid;
  results.push({ name: 'iOS 设备已连接', status: 'ok', detail: udid });

  // 开发者模式
  const devModeOut = tryExec(`pymobiledevice3 amfi developer-mode-status --udid ${udid} 2>/dev/null`, 8000);
  if (devModeOut === null) {
    results.push({
      name: '开发者模式已开启',
      status: 'warn',
      detail: '无法读取（设备可能锁屏或未信任）',
      fix: ['解锁设备并在弹窗上点击「信任」后重试'],
    });
  } else if (/true/i.test(devModeOut)) {
    results.push({ name: '开发者模式已开启', status: 'ok', detail: 'true' });
  } else {
    results.push({
      name: '开发者模式已开启',
      status: 'fail',
      detail: devModeOut,
      fix: [
        '在 iOS 设备上：',
        '  1. 打开「设置」App',
        '  2. 进入「隐私与安全性」',
        '  3. 找到并进入「开发者模式」',
        '  4. 打开开关，根据提示重启设备',
        '  5. 重启后解锁设备并确认开启',
      ],
    });
  }

  // DDI
  const mounterOut = tryExec(`pymobiledevice3 mounter list --udid ${udid} 2>/dev/null`, 8000);
  if (mounterOut === null) {
    results.push({
      name: 'Developer Disk Image 已挂载',
      status: 'warn',
      detail: '无法读取',
      fix: ['解锁设备 & 信任电脑后重试'],
    });
  } else if (/"IsMounted"\s*:\s*true/.test(mounterOut) && /Developer/.test(mounterOut)) {
    results.push({ name: 'Developer Disk Image 已挂载', status: 'ok', detail: '已挂载' });
  } else {
    results.push({
      name: 'Developer Disk Image 已挂载',
      status: 'fail',
      detail: '未挂载',
      fix: [`sudo pymobiledevice3 mounter auto-mount --udid ${udid}`],
    });
  }

  // tunneld 注册表
  const registryRaw = tryExec('curl -s --max-time 2 http://127.0.0.1:49151', 3000);
  let inRegistry = false;
  if (registryRaw) {
    try {
      const obj = JSON.parse(registryRaw);
      if (obj && typeof obj === 'object') {
        const lower = udid.toLowerCase();
        inRegistry = Object.keys(obj).some((k) => k === udid || k.toLowerCase() === lower);
      }
    } catch {}
  }
  if (inRegistry) {
    results.push({ name: 'tunneld 注册表包含设备', status: 'ok', detail: '已就绪' });
  } else {
    results.push({
      name: 'tunneld 注册表包含设备',
      status: 'warn',
      detail: registryRaw === null ? 'tunneld 未运行' : '注册表未包含该设备',
      fix: [
        '执行任意需要 tunneld 的命令（如 hex screenshot）会自动启动并接管',
        '或手动：sudo pymobiledevice3 remote tunneld',
      ],
    });
  }

  // WDA 安装检测
  if (!devicectlPath) {
    results.push({
      name: 'WDA 安装在设备上',
      status: 'skip',
      detail: '需要 xcrun devicectl',
    });
  } else {
    const appsOut = tryExec(`xcrun devicectl device info apps --device "${udid}" 2>/dev/null`, 15000);
    if (appsOut === null) {
      results.push({
        name: 'WDA 安装在设备上',
        status: 'warn',
        detail: '无法读取应用列表（设备可能锁屏或未信任）',
        fix: ['解锁设备并信任电脑后重试'],
      });
    } else if (appsOut.includes('WebDriverAgentRunner')) {
      results.push({ name: 'WDA 安装在设备上', status: 'ok', detail: '已安装' });
    } else {
      results.push({
        name: 'WDA 安装在设备上',
        status: 'warn',
        detail: '未安装',
        fix: ['首次执行 hex tap 会自动编译并安装 WDA（耗时 1-3 分钟）'],
      });
    }
  }

  return results;
}

// ===== HarmonyOS =====

function checkHarmonyos(ctx: Ctx): CheckResult[] {
  const results: CheckResult[] = [];

  const hdcPresent = commandExists('hdc');
  const hdcVer = hdcPresent ? tryExec('hdc -v 2>/dev/null | head -1', 3000) : null;
  results.push({
    name: 'hdc 已安装',
    status: hdcPresent ? 'ok' : 'fail',
    detail: hdcVer || (hdcPresent ? '已安装' : '未找到'),
    fix: hdcPresent
      ? undefined
      : [
          '安装 DevEco Studio，并将 sdk/<api-level>/toolchains 目录加入 PATH',
          '验证：hdc -v 与 hdc list targets',
        ],
  });

  if (!hdcPresent) {
    results.push({
      name: 'HarmonyOS 设备已连接',
      status: 'skip',
      detail: '需要先安装 hdc',
    });
    results.push({
      name: '目标 App 已安装',
      status: 'skip',
      detail: '需要先安装 hdc',
    });
    return results;
  }

  // 设备连接检测
  const targetsRaw = tryExec('hdc list targets 2>/dev/null', 3000) || '';
  const targets = targetsRaw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '[Empty]');

  if (targets.length > 0) {
    // 获取设备产品名
    let productName = '未知';
    if (ctx.harmonyosUdid) {
      const nameOut = tryExec(
        `hdc -t ${ctx.harmonyosUdid} shell param get const.product.name 2>/dev/null`,
        5000,
      );
      if (nameOut) productName = nameOut.replace(/_/g, ' ');
    }
    results.push({
      name: 'HarmonyOS 设备已连接',
      status: 'ok',
      detail: `${targets.length} 台设备 (${ctx.harmonyosUdid}, ${productName})`,
    });
  } else {
    results.push({
      name: 'HarmonyOS 设备已连接',
      status: 'skip',
      detail: '未检测到任何 HarmonyOS 设备（如不需要可忽略）',
      fix: ['确认设备已通过 USB 连接并在开发者选项中开启 USB 调试', 'hdc kill && hdc start'],
    });
    results.push({
      name: '目标 App 已安装',
      status: 'skip',
      detail: '需要先连接 HarmonyOS 设备',
    });
    return results;
  }

  // 目标 App 安装检测
  const udid = ctx.harmonyosUdid!;
  const HARMONYOS_BUNDLE_ID = DEFAULT_HARMONYOS_BUNDLE_ID;
  const bmOut = tryExec(
    `hdc -t ${udid} shell bm dump -n ${HARMONYOS_BUNDLE_ID} 2>/dev/null`,
    8000,
  );
  if (bmOut === null) {
    results.push({
      name: '目标 App 已安装',
      status: 'warn',
      detail: '无法查询应用列表（设备可能未授权）',
      fix: ['在设备上确认 USB 调试已授权', 'hdc kill && hdc start'],
    });
  } else if (bmOut.includes(HARMONYOS_BUNDLE_ID)) {
    // 提取版本号
    const verMatch = bmOut.match(/versionName\s*:\s*(\S+)/);
    const verDetail = verMatch ? `v${verMatch[1]}` : '已安装';
    results.push({
      name: '目标 App 已安装',
      status: 'ok',
      detail: `${HARMONYOS_BUNDLE_ID} (${verDetail})`,
    });
  } else {
    results.push({
      name: '目标 App 已安装',
      status: 'warn',
      detail: `${HARMONYOS_BUNDLE_ID} 未安装`,
      fix: [
        '通过 DevEco Studio 或 devecocli 构建并安装 HAP 包',
        `  hdc install entry-default-signed.hap`,
      ],
    });
  }

  return results;
}

// ===== 输出 =====

function printSection(title: string, results: CheckResult[]): void {
  logger.info(`\n[${title}]`);
  for (const r of results) {
    const tail = r.detail ? `: ${r.detail}` : '';
    const line = `  ${r.name}${tail}`;
    if (r.status === 'ok') logger.success(line);
    else if (r.status === 'fail') logger.error(line);
    else if (r.status === 'warn') logger.warn(line);
    else logger.info(`  ○ ${r.name}${tail}`);

    if ((r.status === 'fail' || r.status === 'warn') && r.fix && r.fix.length > 0) {
      logger.info('    建议：');
      for (const line of r.fix) {
        logger.info(`      ${line}`);
      }
    }
  }
}

function summarize(all: CheckResult[]): { ok: number; fail: number; warn: number; skip: number } {
  const out = { ok: 0, fail: 0, warn: 0, skip: 0 };
  for (const r of all) out[r.status] += 1;
  return out;
}

const doctor = new Command('doctor')
  .description('检查 iOS / Android / HarmonyOS 调试所需的环境与第三方工具，并对失败项给出修复建议')
  .action(() => {
    const ctx: Ctx = {
      androidSerial: detectAndroidSerial(),
      iosUdid: detectIosUdid(),
      harmonyosUdid: detectHarmonyosUdid(),
    };

    logger.info('HexCli Doctor 体检开始');
    if (ctx.iosUdid) logger.info(`检测到 iOS 设备：${ctx.iosUdid}`);
    if (ctx.androidSerial) logger.info(`检测到 Android 设备：${ctx.androidSerial}`);
    if (ctx.harmonyosUdid) logger.info(`检测到 HarmonyOS 设备：${ctx.harmonyosUdid}`);

    const all: CheckResult[] = [];

    const general = checkGeneral();
    printSection('通用', general);
    all.push(...general);

    const android = checkAndroid(ctx);
    printSection('Android', android);
    all.push(...android);

    const ios = checkIos(ctx);
    printSection('iOS', ios);
    all.push(...ios);

    const harmonyos = checkHarmonyos(ctx);
    printSection('HarmonyOS', harmonyos);
    all.push(...harmonyos);

    const s = summarize(all);
    logger.info('');
    logger.info('—— 汇总 ——');
    if (s.ok > 0) logger.success(`通过 ${s.ok} 项`);
    if (s.warn > 0) logger.warn(`告警 ${s.warn} 项`);
    if (s.fail > 0) logger.error(`未通过 ${s.fail} 项`);
    if (s.skip > 0) logger.info(`跳过 ${s.skip} 项`);

    process.exit(s.fail > 0 ? 1 : 0);
  });

export default doctor;
