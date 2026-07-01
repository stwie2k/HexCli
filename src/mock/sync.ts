import { dispatchCommand } from '../utils/dispatch.js';
import { MtopMockPayload } from './store.js';

/**
 * 将 payload 下发到设备。要求 daemon 在线且至少一台设备已连接，失败时抛错。
 * 多设备且未传 --udid / 未设 session 默认 -> 报错列候选（由 selector 负责）。
 */
export async function applyToDevice(payload: MtopMockPayload): Promise<void> {
  const response = await dispatchCommand('mtopMock', payload);
  if (!response.success) {
    throw new Error(response.error || '下发 mtopMock 失败');
  }
}

/**
 * 清空设备端的 mock 规则和自定义 Header。
 */
export async function clearDevice(): Promise<void> {
  await applyToDevice({
    mtopOpen: false,
    mockItems: [],
    customHttpHeaders: {},
  });
}
