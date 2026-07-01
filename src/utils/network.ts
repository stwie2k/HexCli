import { networkInterfaces } from 'os';

/**
 * 获取本机局域网 IPv4 地址（非 127.0.0.1、非内部接口）。
 * 若获取不到，返回 '127.0.0.1' 作为兜底。
 */
export function getLocalIP(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const ifaceList = interfaces[name];
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      // 仅取 IPv4、非内部、非回环地址
      const family = (iface as any).family;
      const isIPv4 = family === 'IPv4' || family === 4;
      if (isIPv4 && !iface.internal && iface.address !== '127.0.0.1') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
