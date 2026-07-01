import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as logger from '../utils/logger.js';
import { getLogDir } from '../utils/logger.js';

/**
 * 校验 --date 参数格式：YYYY-MM-DD。
 */
function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const log = new Command('log')
  .description('查看 Hex CLI 日志（默认打开当天日志文件）')
  .option('-f, --follow', '使用 tail -f 实时跟随当天日志')
  .option('-e, --error', '查看当天错误日志（仅 ERROR 级别）')
  .option('-d, --date <YYYY-MM-DD>', '指定日期，默认今天')
  .option('-l, --list', '列出日志目录下所有日志文件')
  .option('--dir', '仅打印日志目录路径，不打开文件')
  .action((options) => {
    const dir = getLogDir();

    // --dir：只输出路径，方便其他工具（如 cd $(hex log --dir)）
    if (options.dir) {
      console.log(dir);
      return;
    }

    // --list：列出所有日志文件
    if (options.list) {
      if (!fs.existsSync(dir)) {
        logger.info(`日志目录尚未创建：${dir}`);
        return;
      }
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .sort()
        .reverse();
      if (files.length === 0) {
        logger.info(`日志目录为空：${dir}`);
        return;
      }
      logger.info(`日志目录：${dir}`);
      for (const f of files) {
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        const sizeKb = (st.size / 1024).toFixed(1);
        console.log(`  ${f.padEnd(30)} ${sizeKb.padStart(8)} KB   ${st.mtime.toISOString()}`);
      }
      return;
    }

    // 解析目标日期
    const date = options.date || todayStr();
    if (!isValidDate(date)) {
      logger.error(`--date 格式必须为 YYYY-MM-DD：${date}`);
      process.exit(1);
    }

    const filename = options.error ? `${date}.error.log` : `${date}.log`;
    const target = path.join(dir, filename);

    if (!fs.existsSync(target)) {
      logger.warn(`日志文件不存在：${target}`);
      logger.info('使用 hex log --list 查看可用日志');
      return;
    }

    // -f：tail -f 跟随
    if (options.follow) {
      logger.info(`实时跟随：${target}（Ctrl+C 退出）`);
      const child = spawn('tail', ['-f', target], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }

    // 默认：用系统默认应用打开（macOS 会根据扩展名匹配）
    logger.info(`打开日志：${target}`);
    try {
      execSync(`open "${target}"`, { stdio: 'ignore' });
    } catch {
      logger.error('打开失败，使用 cat / less 查看：');
      console.log(`  cat "${target}"`);
    }
  });

export default log;
