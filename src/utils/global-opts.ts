/**
 * 全局 CLI 选项的运行时存储。
 *
 * commander 的全局 option 在 program.opts() 上可见，但深层命令文件取值不便；
 * 因此在顶层 program preAction hook 中把全局 udid 注入到这里，下游统一读取。
 */

let globalUdid: string | undefined;

export function setGlobalUdid(v: string | undefined): void {
  globalUdid = v && v.trim() ? v.trim() : undefined;
}

export function getGlobalUdid(): string | undefined {
  return globalUdid;
}
