import { sendToDaemon, type CommandResult } from '../daemon/client.js';
import { resolveTarget } from './selector.js';

/**
 * 高层命令分发：自动解析 selector，再走 IPC 下发到目标设备。
 *
 * 命令文件无需关心 udid 的取值过程：
 *   - 显式 --udid 走 udid
 *   - 单设备走该唯一设备
 *   - 多设备无显式参数 -> 抛错列候选（与 utils/selector 一致）
 */
export async function dispatchCommand(
  command: string,
  params?: Record<string, any>,
  opts?: { udid?: string },
): Promise<CommandResult> {
  const { udid } = await resolveTarget(opts);
  return sendToDaemon(command, params, udid);
}
