import { Command } from 'commander';
import { dispatchCommand } from '../utils/dispatch.js';
import * as logger from '../utils/logger.js';

const VALID_REDIRECT_TYPES = ['urlToUrl', 'pathToUrl', 'regexToUrl'] as const;

/**
 * 通用执行：通过 Daemon IPC 发送命令，输出结果并退出。
 */
async function execCommand(
  command: string,
  params: Record<string, any> | undefined,
  successMsg: string,
): Promise<void> {
  try {
    const response = await dispatchCommand(command, params);
    if (response.success) {
      logger.success(successMsg);
      if (response.result !== undefined && response.result !== null) {
        logger.json(response.result);
      }
    } else {
      logger.error(response.error || '命令执行失败');
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    logger.error(err.message);
    process.exit(1);
  }
}

export const openUrl = new Command('open-url')
  .description('在设备上打开页面')
  .argument('<url>', '要打开的页面 URL')
  .action(async (url: string) => {
    await execCommand('openUrl', { url }, `已打开页面: ${url}`);
  });

export const whitelist = new Command('whitelist')
  .description('域名白名单管理')
  .argument('[host]', '要添加的域名')
  .option('--all-pass-on', '开启全域名白名单（放行所有域名）')
  .option('--all-pass-off', '关闭全域名白名单（恢复域名拦截）')
  .action(async (host: string | undefined, opts: { allPassOn?: boolean; allPassOff?: boolean }) => {
    const { allPassOn, allPassOff } = opts;

    // 互斥校验：--all-pass-on 与 --all-pass-off 不能同时指定
    if (allPassOn && allPassOff) {
      logger.error('--all-pass-on 与 --all-pass-off 不能同时指定');
      process.exit(1);
    }

    // 模式一：全域名白名单开关
    if (allPassOn || allPassOff) {
      if (host) {
        logger.error('不能同时指定 <host> 和 --all-pass-on/--all-pass-off');
        process.exit(1);
      }
      const isOpen = Boolean(allPassOn);
      await execCommand(
        'allWhite',
        { isOpen },
        `全域名白名单已${isOpen ? '开启' : '关闭'}`,
      );
      return;
    }

    // 模式二：添加单个域名白名单
    if (!host) {
      logger.error('必须指定 <host> 或使用 --all-pass-on/--all-pass-off');
      process.exit(1);
    }
    await execCommand('addWhiteHost', { whiteHost: host }, `已添加白名单域名: ${host}`);
  });

export const redirect = new Command('redirect')
  .description('URL 重定向')
  .requiredOption('--type <type>', `重定向类型 (${VALID_REDIRECT_TYPES.join(' | ')})`)
  .requiredOption('--source <source>', '源 URL/路径/正则')
  .requiredOption('--target <target>', '目标 URL')
  .action(async (options: { type: string; source: string; target: string }) => {
    const { type, source, target } = options;

    if (!VALID_REDIRECT_TYPES.includes(type as typeof VALID_REDIRECT_TYPES[number])) {
      logger.error(
        `非法的 --type 值: "${type}"，可选值为 ${VALID_REDIRECT_TYPES.join(', ')}`
      );
      process.exit(1);
    }

    await execCommand(
      'UrlRedirect',
      { type, source, target },
      `已设置 URL 重定向: [${type}] ${source} -> ${target}`,
    );
  });
