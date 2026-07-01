import { Command } from 'commander';
import { dispatchCommand } from '../utils/dispatch.js';
import { resolveTarget } from '../utils/selector.js';
import * as logger from '../utils/logger.js';
import { runOpen } from './open.js';
import { getGlobalUdid } from '../utils/global-opts.js';

const env = new Command('env').description('基础环境设置');

/**
 * 解析 --on / --off 选项，返回 boolean。
 * 若两者都未指定或同时指定，输出错误并退出进程。
 */
function resolveToggle(opts: { on?: boolean; off?: boolean }): boolean {
  if (opts.on && opts.off) {
    logger.error('--on 与 --off 不能同时指定');
    process.exit(1);
  }
  if (!opts.on && !opts.off) {
    logger.error('必须指定 --on 或 --off');
    process.exit(1);
  }
  return Boolean(opts.on);
}

/**
 * 通用执行：通过 Daemon IPC 发送命令，输出结果并退出。
 */
async function runCommand(
  command: string,
  params: Record<string, any>,
  successMessage: string,
  opts?: { udid?: string },
): Promise<void> {
  try {
    const response = await dispatchCommand(command, params, opts);
    if (response.success) {
      logger.success(successMessage);
      if (response.result !== undefined && response.result !== null) {
        logger.json(response.result);
      }
    } else {
      logger.error(response.error || '命令执行失败');
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    logger.error(`命令执行失败: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
}

/**
 * 环境切换专用：执行 Daemon 命令成功后，复用 hex open 的启动应用逻辑
 * （内部 launchIOSApp / launchAndroidApp 已带 terminate-existing / force-stop，
 * 等价于先关闭手机侧应用再重新启动），使新环境生效。
 *
 * 多设备场景下需要把全局 --udid 透传给 runOpen，否则重启会因
 * "检测到多台已连接设备" 而失败。
 */
async function runEnvSwitch(
  command: string,
  params: Record<string, any>,
  successMessage: string,
): Promise<void> {
  const udid = getGlobalUdid();
  try {
    const response = await dispatchCommand(command, params);
    if (!response.success) {
      logger.error(response.error || '命令执行失败');
      process.exit(1);
    }
    logger.success(successMessage);
    if (response.result !== undefined && response.result !== null) {
      logger.json(response.result);
    }
  } catch (err: any) {
    logger.error(`命令执行失败: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
  // 记录 launch 前的时间戳，供 runOpen 过滤旧连接
  const launchTime = Date.now();

  // terminate-existing / force-stop 只是发信号，给旧进程一点时间完全退出，
  // 避免旧 WebSocket 连接尚未断开时被误判为新连接已就绪
  await new Promise((r) => setTimeout(r, 1500));

  // 重新调用 hex 启动应用的命令，关闭并重启手机侧应用
  logger.info('正在重启应用以使新环境生效...');
  try {
    await runOpen({ udid, connectedAfter: launchTime });
  } catch (err: any) {
    logger.warn(
      `自动重启失败: ${err?.message ?? String(err)}，请手动执行 hex open 重启应用`,
    );
  }
  process.exit(0);
}

// hexcli env online —— 切换到线上环境
env
  .command('online')
  .description('切换到线上环境（自动重启应用）')
  .action(async () => {
    await runEnvSwitch('networkOnline', { isOnline: true }, '已切换到线上环境');
  });

// hexcli env pre —— 切换到预发环境
env
  .command('pre')
  .description('切换到预发环境（自动重启应用）')
  .action(async () => {
    await runEnvSwitch('networkOnline', { isOnline: false }, '已切换到预发环境');
  });

// hexcli env gray —— 灰度开关
env
  .command('gray')
  .description('灰度开关')
  .option('--on', '开启')
  .option('--off', '关闭')
  .action(async (opts) => {
    const isGray = resolveToggle(opts);
    await runCommand(
      'rocGray',
      { isGray },
      `灰度已${isGray ? '开启' : '关闭'}`,
    );
  });

// hexcli env downgrade —— 降级开关
env
  .command('downgrade')
  .description('降级开关')
  .option('--on', '开启')
  .option('--off', '关闭')
  .action(async (opts) => {
    const demoteSpdy = resolveToggle(opts);
    await runCommand(
      'demoteSpdy',
      { demoteSpdy, persistance: true },
      `降级已${demoteSpdy ? '开启' : '关闭'}`,
    );
  });

// hexcli env cybert —— CyberT 组件调试开关
env
  .command('cybert')
  .description('CyberT 组件调试开关')
  .option('--on', '开启')
  .option('--off', '关闭')
  .action(async (opts) => {
    const open = resolveToggle(opts);
    await runCommand(
      'widgetDebug',
      { open },
      `CyberT 组件调试已${open ? '开启' : '关闭'}`,
    );
  });


// hexcli env https-downgrade —— HTTPS 降级开关
// Android 端只识别 demoteSpdy 命令，鸿蒙端识别 httpsDemote 命令，需按平台分发
env
  .command('https-downgrade')
  .description('HTTPS 降级开关')
  .option('--on', '开启')
  .option('--off', '关闭')
  .action(async (opts) => {
    const isOpen = resolveToggle(opts);
    const { udid, devices } = await resolveTarget();
    const device = devices.find((d) => d.deviceId === udid);
    // Android 只识别 demoteSpdy 命令，参数名为 demoteSpdy
    // iOS, HarmonyOS 识别 httpsDemote 命令，参数名为 isOpen
    if (device?.platform === 'android') {
      await runCommand('demoteSpdy', { demoteSpdy: isOpen, persistance: true }, `HTTPS 降级已${isOpen ? '开启' : '关闭'}`, { udid });
    } else {
      await runCommand('httpsDemote', { isOpen }, `HTTPS 降级已${isOpen ? '开启' : '关闭'}`, { udid });
    }
  });

export default env;
