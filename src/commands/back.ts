import { Command } from 'commander';
import { dispatchCommand } from '../utils/dispatch.js';
import * as logger from '../utils/logger.js';

const back = new Command('back')
  .description('触发设备页面返回')
  .action(async () => {
    try {
      const response = await dispatchCommand('navigateBack', {});
      if (response.success) {
        logger.success('返回指令已下发');
      } else {
        logger.error(response.error || '返回指令执行失败');
        process.exit(1);
      }
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
    process.exit(0);
  });

export default back;
