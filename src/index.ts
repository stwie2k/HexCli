import { Command } from 'commander';
import { createRequire } from 'node:module';
import env from './commands/env.js';
import { openUrl, whitelist, redirect } from './commands/h5.js';
import query from './commands/query.js';
import open from './commands/open.js';
import stop from './commands/stop.js';
import mock from './commands/mock.js';
import login from './commands/login.js';
import screenshot from './commands/screenshot.js';
import update from './commands/update.js';
import doc from './commands/doc.js';
import log from './commands/log.js';
import { tap, swipe } from './commands/tap.js';
import back from './commands/back.js';
import debug from './commands/debug.js';
import doctor from './commands/doctor.js';
import { device } from './commands/devices.js';
import screen from './commands/screen.js';
import inspect from './commands/inspect.js';
import clear from './commands/clear.js';
import { setGlobalUdid } from './utils/global-opts.js';
import { isSafeUdid } from './utils/udid-safe.js';
import { initLogger, setCommand, finalize, debug as logDebug, error as logError } from './utils/logger.js';
import type { Command as CommanderCommand } from 'commander';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

// 入口兑底初始化：覆盖 --help / --version / 无参数 等不走 preAction 的场景，
// 保证任何路径都有 START 标记。preAction 后续用 setCommand 覆写真实子命令名。
initLogger('cli', pkg.version);

// 全局异常兑底：任何未捕获错误都要进日志，避免“闪退”丢失现场
process.on('uncaughtException', (err) => {
  logError(`uncaughtException: ${err?.message || String(err)}`);
  if (err?.stack) logDebug(`stack: ${err.stack}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  logError(`unhandledRejection: ${reason?.message || String(reason)}`);
  if (reason?.stack) logDebug(`stack: ${reason.stack}`);
  process.exit(1);
});
// 进程退出时补上 END 标记
process.on('exit', (code) => {
  finalize(code);
});

/**
 * 拼接子命令路径，如 hex tap reset → 'tap.reset'。
 * 顶层 hex 名不计入，纯友好与 command-grouping。
 */
function buildCommandPath(cmd: CommanderCommand | undefined | null): string {
  if (!cmd) return 'cli';
  const parts: string[] = [];
  let cur: any = cmd;
  while (cur && cur.name && cur.name() !== 'hex') {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  return parts.length > 0 ? parts.join('.') : 'cli';
}

const program = new Command();

program
  .name('hex')
  .description('Hex - 环境配置调试命令行工具')
  .version(pkg.version)
  .option('--udid <udid>', '全局指定设备 UDID（多设备下需显式指定，优先级高于 session）')
  .hook('preAction', (thisCmd, actionCommand) => {
    // 把顶层 --udid 注入到 globalUdid，供下游命令读取
    const opts = thisCmd.opts();
    const rawUdid = opts.udid as string | undefined;
    if (rawUdid && !isSafeUdid(rawUdid)) {
      // 安全兑底：udid 会拼到 xcrun / pymobiledevice3 / adb 命令中，
      // 含 shell 元字符的输入直接拒绝（防命令注入）。
      console.error(
        `\u001b[31m\u2716\u001b[0m --udid 含非法字符或长度异常：${JSON.stringify(rawUdid)}\n` +
          `仅允许：字母、数字、连字符、点号、冒号、下划线`,
      );
      process.exit(1);
    }
    setGlobalUdid(rawUdid);
    // 拿到真实子命令路径（如 tap.reset）后覆写默认 'cli'，
    // 便于后续 grep [tap.reset] / [tap] / [doctor] 过滤。
    setCommand(buildCommandPath(actionCommand));
  });

program.addCommand(env);
program.addCommand(openUrl);
program.addCommand(whitelist);
program.addCommand(redirect);
program.addCommand(query);
program.addCommand(open);
program.addCommand(stop);
program.addCommand(mock);
program.addCommand(login);
program.addCommand(screenshot);
program.addCommand(update);
program.addCommand(doc);
program.addCommand(log);
program.addCommand(tap);
program.addCommand(swipe);
program.addCommand(back);
program.addCommand(debug);
program.addCommand(doctor);
program.addCommand(device);
program.addCommand(screen);
program.addCommand(inspect);
program.addCommand(clear);

const COMMAND_GROUPS: { title: string; cmds: string[] }[] = [
  { title: '会话生命周期', cmds: ['open', 'stop'] },
  { title: '多设备路由', cmds: ['device'] },
  { title: '环境与配置', cmds: ['env', 'mock', 'query', 'whitelist', 'redirect'] },
  { title: '设备交互', cmds: ['login', 'tap', 'swipe', 'back', 'screenshot', 'screen', 'inspect', 'clear', 'open-url'] },
  { title: '调试', cmds: ['debug'] },
  { title: 'CLI 维护', cmds: ['doctor', 'update', 'doc', 'log'] },
];

program.configureHelp({
  visibleCommands: () => [],
});

program.addHelpText('after', () => {
  const allCommands = program.commands.filter((c) => !(c as any)._hidden);
  const byName = new Map(allCommands.map((c) => [c.name(), c]));
  const grouped = new Set(COMMAND_GROUPS.flatMap((g) => g.cmds));
  const ungrouped = allCommands.filter((c) => !grouped.has(c.name()));

  const padWidth = Math.max(...allCommands.map((c) => c.name().length)) + 2;

  const lines: string[] = ['', 'Commands:'];
  for (const group of COMMAND_GROUPS) {
    const cmds = group.cmds.map((n) => byName.get(n)).filter((c): c is Command => Boolean(c));
    if (cmds.length === 0) continue;
    lines.push('');
    lines.push(`  \x1b[1;36m${group.title}\x1b[0m`);
    for (const c of cmds) {
      lines.push(`    ${c.name().padEnd(padWidth)}${c.description()}`);
    }
  }
  if (ungrouped.length > 0) {
    lines.push('');
    lines.push('  \x1b[1;36m其他\x1b[0m');
    for (const c of ungrouped) {
      lines.push(`    ${c.name().padEnd(padWidth)}${c.description()}`);
    }
  }
  return lines.join('\n');
});

program.parse();
