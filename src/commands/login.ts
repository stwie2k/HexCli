import { Command } from 'commander';
import { dispatchCommand } from '../utils/dispatch.js';
import * as logger from '../utils/logger.js';

const login = new Command('login')
  .description('一键登录设备应用')
  .requiredOption('--havana-id <id>', 'Havana ID')
  .requiredOption('--sso-key <key>', 'SSO Key')
  .action(async (options) => {
    const havanaId = Number(options.havanaId);
    const ssoKey: string = options.ssoKey;

    if (!havanaId || !ssoKey) {
      logger.error('havanaId 和 ssoKey 不能为空');
      process.exit(1);
    }

    try {
      logger.info(`正在登录 (havanaId: ${havanaId})...`);

      const response = await dispatchCommand('oneKeyLogin', {
        havanaId,
        ssoKey,
      });

      if (response.success) {
        const result = response.result;
        if (result && result.success) {
          logger.success('登录成功');
        } else {
          logger.error('登录失败');
          process.exit(1);
        }
      } else {
        logger.error(response.error || '命令执行失败');
        process.exit(1);
      }
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
    process.exit(0);
  });

export default login;
