import { Command } from 'commander';
import { execSync } from 'child_process';
import * as logger from '../utils/logger.js';
import { NPM_REGISTRY } from '../utils/constants.js';

const PKG = '@ali/hexcli';
const REGISTRY = NPM_REGISTRY;

const update = new Command('update')
  .description('更新 Hex CLI 到最新版本')
  .action(async () => {
    logger.info(`正在从 ${REGISTRY} 拉取最新版本...`);

    try {
      execSync(`npm install -g ${PKG} --registry=${REGISTRY}`, {
        encoding: 'utf-8',
        stdio: 'inherit',
        timeout: 120000,
      });
      logger.success('更新完成！运行 hex --version 查看当前版本');
    } catch (err: any) {
      logger.error(`更新失败: ${err.message}`);
      logger.info(`请手动执行: npm i -g ${PKG} --registry=${REGISTRY}`);
      logger.info('若提示 EEXIST，请先 rm $(which hex) 后重试');
      process.exit(1);
    }
  });

export default update;
