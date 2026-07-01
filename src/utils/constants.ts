/**
 * NPM Registry 地址。
 * 优先读取环境变量 HEX_NPM_REGISTRY，未设置时使用默认值。
 */
export const NPM_REGISTRY =
  process.env.HEX_NPM_REGISTRY || 'https://registry.npmjs.org';

/**
 * 文档页面 URL。
 * 优先读取环境变量 HEX_DOC_URL，未设置时使用默认值。
 */
export const DOC_URL =
  process.env.HEX_DOC_URL || 'https://hexcli.dev/docs';

/**
 * 默认目标 App 包名（iOS bundleId / Android packageName 统一）。
 * 可通过环境变量 HEX_DEFAULT_BUNDLE_ID 覆盖。
 */
export const DEFAULT_BUNDLE_ID =
  process.env.HEX_DEFAULT_BUNDLE_ID || 'com.example.app';

/**
 * HarmonyOS 默认包名（鸿蒙端 bundleId 与 iOS/Android 不同）。
 * 可通过环境变量 HEX_DEFAULT_HARMONYOS_BUNDLE_ID 覆盖。
 */
export const DEFAULT_HARMONYOS_BUNDLE_ID =
  process.env.HEX_DEFAULT_HARMONYOS_BUNDLE_ID || 'com.example.app_hmos';
