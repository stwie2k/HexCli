import { Command } from 'commander';
import * as logger from '../utils/logger.js';
import {
  MOCK_FILE_PATH,
  buildPayload,
  defaultTemplate,
  loadMockFile,
  mockFileExists,
  writeMockFile,
} from '../mock/store.js';
import { applyToDevice, clearDevice } from '../mock/sync.js';

// 对象/数组 递归截断超长字符串、折叠超长数组
const STR_TRUNCATE_THRESHOLD = 200;
const STR_TRUNCATE_KEEP = 120;
const ARRAY_PREVIEW_KEEP = 8;

function summarize(v: any): any {
  if (typeof v === 'string') {
    if (v.length <= STR_TRUNCATE_THRESHOLD) return v;
    return `${v.slice(0, STR_TRUNCATE_KEEP)}… <truncated, total ${v.length} chars>`;
  }
  if (Array.isArray(v)) {
    if (v.length <= ARRAY_PREVIEW_KEEP) return v.map(summarize);
    const head = v.slice(0, ARRAY_PREVIEW_KEEP).map(summarize);
    head.push(`… <truncated, total ${v.length} items>`);
    return head;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = summarize(val);
    return out;
  }
  return v;
}

const mock = new Command('mock').description('Mtop Mock 规则管理');

// hex mock init —— 生成模板
mock
  .command('init')
  .description('生成 mock 配置模板 (~/.hexcli/mock.json)')
  .action(() => {
    if (mockFileExists()) {
      logger.error(`文件已存在: ${MOCK_FILE_PATH}（避免覆盖，请手动编辑或先删除）`);
      process.exit(1);
    }
    writeMockFile(defaultTemplate());
    logger.success(`已生成模板: ${MOCK_FILE_PATH}`);
    logger.info('可直接编辑该文件后执行: hex mock apply');
    process.exit(0);
  });

// hex mock show —— 预览本地配置
mock
  .command('show')
  .description('预览本地 mock 规则（纯本地，不查询也不下发到设备）')
  .option('-f, --full', '显示完整内容（默认对超长字符串截断）', false)
  .action((opts: { full?: boolean }) => {
    try {
      const file = loadMockFile();
      const view = opts.full ? file : summarize(file);
      logger.info('[本地配置]');
      logger.json(view);
      console.log();
      logger.info(`编辑 mock 数据: open ${MOCK_FILE_PATH}`);
      if (!opts.full) {
        logger.info('查看完整内容: hex mock show --full');
      }
      logger.info('下发到设备: hex mock apply');
      process.exit(0);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

// hex mock apply —— 下发到设备
mock
  .command('apply')
  .description('将 mock 规则下发到设备')
  .action(async () => {
    try {
      const file = loadMockFile();
      const payload = buildPayload(file, { open: true });
      await applyToDevice(payload);
      logger.success(`已下发 ${payload.mockItems.length} 条规则、${Object.keys(payload.customHttpHeaders).length} 个自定义 Header`);
      process.exit(0);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

// hex mock clear —— 清空设备端规则
mock
  .command('clear')
  .description('清空设备上的 mock 规则（本地配置不受影响）')
  .action(async () => {
    try {
      await clearDevice();
      logger.success('已清空设备端的 Mock 规则和自定义 Header');
      process.exit(0);
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

export default mock;
