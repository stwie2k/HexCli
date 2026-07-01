import { Command } from 'commander';
import { dispatchCommand } from '../utils/dispatch.js';
import * as logger from '../utils/logger.js';

const query = new Command('query').description('查询设备配置信息');

// appInfo 中文 key → 英文 key 映射
const APP_INFO_KEY_MAP: Record<string, string> = {
  应用名称: 'appName',
  App版本号: 'appVersion',
  构建号: 'buildNumber',
  构建环境: 'buildEnv',
  AppKey: 'appKey',
  包名: 'bundleId',
  设备ID: 'deviceId',
  用户ID: 'userId',
  用户昵称: 'nickName',
  UTDID: 'utdid',
  CAID: 'caid',
  设备名称: 'deviceName',
  系统版本: 'osVersion',
  设备型号: 'deviceModel',
  屏幕尺寸: 'screenSize',
  ipv4地址: 'ipv4',
  ipv6地址: 'ipv6',
  定位权限: 'locationPermission',
  推送权限: 'pushPermission',
  拍照权限: 'cameraPermission',
  麦克风权限: 'microphonePermission',
  相册权限: 'photoLibraryPermission',
  通讯录权限: 'contactsPermission',
  日历权限: 'calendarPermission',
};

/**
 * 通用执行：通过 Daemon IPC 发送查询命令，输出结果并退出。
 */
async function execQuery(
  command: string,
  params: Record<string, any> | undefined,
  errorMsg: string,
): Promise<void> {
  try {
    const response = await dispatchCommand(command, params);
    if (response.success) {
      logger.json(response.result);
    } else {
      logger.error(response.error || errorMsg);
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`${errorMsg}: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
  process.exit(0);
}

// hexcli query orange <groupName>
query
  .command('orange <groupName>')
  .description('查询 Orange 配置')
  .action(async (groupName: string) => {
    await execQuery('orangeInfo', { groupName }, '查询 Orange 配置失败');
  });

// hexcli query ab --component <comp> [--module <mod>]
query
  .command('ab')
  .description('查询 AB 测试')
  .requiredOption('--component <comp>', '组件名称')
  .option('--module <mod>', '模块名称', '')
  .action(async (options: { component?: string; module?: string }) => {
    if (!options.component) {
      logger.error('缺少必填参数 --component');
      process.exit(1);
    }
    await execQuery(
      'ABTest',
      { component: options.component, module: options.module ?? '' },
      '查询 AB 测试失败',
    );
  });

// hexcli query cookie [--web] [--url <url>]
query
  .command('cookie')
  .description('查询 Cookie')
  .option('--web', '查询 webview cookie', false)
  .option('--url <url>', '目标 URL')
  .action(async (options: { web?: boolean; url?: string }) => {
    await execQuery(
      'cookie',
      { webCookie: !!options.web, url: options.url ?? '' },
      '查询 Cookie 失败',
    );
  });

// hexcli query lastpageapm
query
  .command('lastpageapm')
  .description('查询上一个页面的 APM 性能数据')
  .action(async () => {
    await execQuery('lastPageAPM', undefined, '查询上一个页面 APM 失败');
  });

// hexcli query launchapm
query
  .command('launchapm')
  .description('查询应用启动的 APM 性能数据')
  .action(async () => {
    await execQuery('launchAPM', undefined, '查询启动 APM 失败');
  });

// hexcli query appinfo
query
  .command('appinfo')
  .description('查询应用构建信息')
  .action(async () => {
    try {
      const response = await dispatchCommand('appInfo', undefined);
      if (response.success) {
        const result = response.result as Record<string, any>;
        // 将 appInfoString 解析为结构化对象
        if (result && typeof result.appInfoString === 'string') {
          const parsed: Record<string, string> = {};
          const lines = result.appInfoString.split('\n');
          for (const line of lines) {
            const sep = line.indexOf(':');
            if (sep > 0) {
              const key = line.substring(0, sep).trim();
              const value = line.substring(sep + 1).trim();
              if (key) {
                const mappedKey = APP_INFO_KEY_MAP[key] ?? key;
                parsed[mappedKey] = value;
              }
            }
          }
          result.appInfo = parsed;
          delete result.appInfoString;
        }
        logger.json(result);
      } else {
        logger.error(response.error || '查询应用构建信息失败');
        process.exit(1);
      }
    } catch (err: any) {
      logger.error(`查询应用构建信息失败: ${err?.message ?? String(err)}`);
      process.exit(1);
    }
    process.exit(0);
  });

export default query;
