import { Command } from 'commander';
import { execSync } from 'child_process';
import * as logger from '../utils/logger.js';
import { DOC_URL } from '../utils/constants.js';

const doc = new Command('doc')
  .description('打开 Hex CLI 文档页面')
  .action(() => {
    logger.info(`正在打开文档: ${DOC_URL}`);
    try {
      execSync(`open "${DOC_URL}"`, { stdio: 'ignore' });
      logger.success('文档已在浏览器中打开');
    } catch {
      logger.error('打开文档失败');
      logger.info(`请手动打开: ${DOC_URL}`);
    }
  });

export default doc;
