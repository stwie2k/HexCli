---
name: hex-cli
description: HexCli (`hex` 命令行) 完整使用手册：1688 移动端调试 CLI，覆盖会话生命周期、多设备路由、环境切换、URL 重定向、Mock、查询、登录、UI 交互（tap/swipe/back/screenshot/inspect）、实时调试事件流、日志诊断等全部能力。当用户在 1688/HexCli 项目中提到 hex 命令、移动端调试、设备 UDID、daemon、WebSocket 调试、ECHRemoteDebug、divine_alibaba/divine_launch 联调，或问 "怎么 mock"、"怎么切环境"、"怎么登录设备"、"怎么截图/点击"、"怎么查看视图树"、"hex open 不连接"、"两台设备如何切换" 等问题时使用本 skill。
---

# HexCli 命令使用手册

`hex` 是 1688 移动端调试 CLI（NPM 包 `@ali/hexcli`）。架构上分两层：

- **Daemon**：常驻后台进程，WebSocket Server (`12588`) 负责设备通信，IPC HTTP Server (`12589`) 接受命令请求
- **独立命令**：每条 `hex xxx` 子进程通过 IPC 找 Daemon，Daemon 不在则自动拉起

设备身份由端侧 `Hex_Device_UDID` 注入，3.0.0 起多设备并存。**仅 `--udid` 一个入口选择设备**，无 `--platform`。

支持三端：**iOS** / **Android** / **HarmonyOS**，CLI 通过 USB 枚举自动识别平台（`xcrun xctrace` / `adb devices` / `hdc list targets`）。

## 前置安装

```bash
npm i -g @ali/hexcli --registry=$HEX_NPM_REGISTRY
```

- 装完即可在任意目录使用 `hex` 命令
- 升级直接重跑同一条命令，或使用 `hex update`
- 若提示 `EEXIST`，先 `rm $(which hex)` 再重试
- 卸载：`npm uninstall -g @ali/hexcli`

## 命令大盘（按使用频率）

| 命令 | 用途 |
| --- | --- |
| `hex open [--udid]` | 启动手机端 app 并接入 Daemon（最常用入口） |
| `hex stop` | 停止 Daemon + 关闭 App + 清理 WDA |
| `hex device list` | 表格查看：USB 接入状态 / WS 在线状态 / AppVer / 时长 |
| `hex device use <udid>` | 设默认设备（多设备场景免每次输 `--udid`） |
| `hex env online\|pre` | 切线上/预发（自动重启 app） |
| `hex env gray\|downgrade\|cybert\|https-downgrade --on\|--off` | 单项开关 |
| `hex open-url <url>` | 设备打开页面 |
| `hex redirect --type <t> --source <s> --target <t>` | URL 重定向 |
| `hex whitelist <host>` / `hex whitelist --all-pass-on\|--all-pass-off` | 域名白名单管理 |
| `hex query appinfo\|orange\|ab\|cookie\|lastpageapm\|launchapm` | 查端侧配置 |
| `hex mock init\|show\|apply\|clear` | 单文件声明式 Mock（`~/.hexcli/mock.json`） |
| `hex login --havana-id <id> --sso-key <key>` | 一键登录 |
| `hex tap -x <x> -y <y>` / `hex tap --text <文本>` / `hex swipe` / `hex back` | UI 自动化（坐标/文本点击、滑动、返回） |
| `hex inspect [--all] [--json]` | 查看设备当前页面视图树（类型 + 文本 + frame） |
| `hex screen` | 查询设备屏幕宽高（tap/swipe 前先查，防止坐标越界。单位：iOS pt / Android dp / HarmonyOS vp） |
| `hex screenshot [-o]` | 设备截图 |
| `hex debug [--type] [--script]` | 实时事件流（nav/ut/mtop/mtop-ssr） |
| `hex doctor` | 环境体检（adb/xcrun/pymobiledevice3 等） |
| `hex log [-f\|-e\|-l]` | 查 CLI 日志（`~/.hexcli/logs/`） |
| `hex update` / `hex doc` | 更新 / 打开文档 |

完整参数与每个子命令的用法见 [reference.md](reference.md)。

## 高频工作流

### 1. 单设备日常调试

```bash
hex open                      # 自动选中唯一设备并拉起 app
hex env pre                   # 切预发
hex query appinfo             # 验证 app 信息
# ... 调试中
hex stop                      # 收摊
```

### 2. 多设备并行

```bash
hex open --udid 00008110-001A...      # 拉起 iPhone
hex open --udid RFCX51815QK           # 拉起 Android
hex device list                       # 验证两台都 USB ✔ + WS ✔
hex device use 00008110-001A...       # 把 iPhone 设为默认
hex env online                        # 自动作用于 iPhone
hex query appinfo --udid RFCX51815QK  # 临时切到 Android
```

### 3. Mock（声明式单文件）

```bash
hex mock init                 # 在 ~/.hexcli/mock.json 写入模板
$EDITOR ~/.hexcli/mock.json   # 自己编辑 rules + headers
hex mock show                 # 不联机校验 + 预览
hex mock apply                # 下发到设备
hex mock clear                # 清空设备端（不删本地文件）
```

`mock.json` 单条规则三选一字段：

```jsonc
{
  "rules": [
    { "method": "mtop.xxx", "params": "kw", "content": { "data": {} } },     // 对象
    { "method": "mtop.yyy", "content": "{\"raw\":true}" },                   // 字符串原样
    { "method": "mtop.zzz", "contentFile": "~/mocks/zzz.json" }              // 外部文件
  ],
  "headers": { "X-Trace-Id": "abc" }
}
```

### 4. URL 重定向

```bash
hex redirect --type urlToUrl   --source "https://old.com" --target "https://new.com"
hex redirect --type pathToUrl  --source "/old-path"        --target "https://new.com/p"
hex redirect --type regexToUrl --source ".*old.*"          --target "https://new.com"
```

Android 端规则注册到 Nav 框架原生 Redirector（`HexUrlRedirector`），所有 `Navn.from().to(uri)` 自动经过；进程重启清空。

### 5. UI 自动化（tap / swipe）

```bash
hex screen                     # 先查屏幕宽高，确认坐标范围
hex tap -x 200 -y 500          # 再点击（坐标不会越界）
hex swipe --from 300,800 --to 300,200   # 滑动也同理
```

> **最佳实践**：执行 `hex tap` / `hex swipe` 前，先 `hex screen` 获取当前设备屏幕宽高，确保坐标在有效范围内。坐标单位跨平台一致：iOS = pt、Android = dp、HarmonyOS = vp。

### 6. 实时调试事件流

```bash
hex debug                                       # 终端打印全部 4 类事件
hex debug --type mtop,ut                        # 只看 mtop + ut
hex debug --script ./on-event.sh                # 异步回调脚本
hex debug --stop                                # 停后台 worker
hex debug --status                              # 查状态
```

事件类型：`nav`（AppLog）/ `ut`（埋点）/ `mtop`（接口）/ `mtop-ssr`（SSR）。

## 排错速查

| 现象 | 处理 |
| --- | --- |
| `hex open` 提示成功但 App 没起来 | 检查 `cmd package query-activities` 输出是否被 ResolverActivity 抢占；`hex doctor` 检查 adb |
| `hex device list` 多出一台 UDID=`unknown` | Android 端 `reConnectSocket` 旧版本 bug，更新 SDK 即可 |
| `hex device list` 显示 USB ✔ / WS ✖ | App 未拉起或 WebSocket 未连上；执行 `hex open` |
| 命令报"检测到多台设备" | 加 `--udid <udid>` 或先 `hex device use <udid>` |
| 命令卡死 | `hex stop` 强制清理；再不行 `hex tap reset` 清 WDA 残留 |
| iOS 多设备并发 tap/screenshot 报端口冲突 | `hex tap reset` 清空 `~/.hex-cli/wda-ports.json` 后重试 |
| WebSocket 偶发断开后再无连接 | 杀 app 重起；最新 SDK 已通过 `mWebSocketOpen` 状态位修复 |
| 看历史日志 | `hex log -l`（列文件）/ `hex log -e`（仅 ERROR）/ `hex log -f`（实时跟随） |
| 看不懂当前状态 | `hex doctor` 一键体检环境 |

## 设备选择优先级（5 步链）

下发到 Daemon 的命令选目标设备的顺序：

1. 命令行 `--udid <udid>` 显式指定（含全局 `hex --udid <udid> xxx`）
2. `~/.hexcli/session.json` 中的默认设备且当前在线
3. 仅 1 台设备在线 → 自动选中
4. ≥2 台且未指定 → **报错并列出候选**，绝不随机选
5. 0 台在线 → 提示 `hex open`

本机直发命令（`tap` / `swipe` / `screenshot` / `screen` / `inspect` / `tap reset`）选的是 USB 接入设备，不依赖 Daemon。

## 关键约定

- **两个本地目录别搞混**：
  - `~/.hexcli/` —— Daemon / session / mock / debug worker（**daemon 系**）
  - `~/.hex-cli/` —— CLI 日志 / WDA 工程 / WDA 端口表（**WDA & 日志系**）
- **端口**：Daemon `12588`(WS) / `12589`(IPC HTTP)；WDA 每台 iOS 设备从 `8100-8199` 范围分配（`~/.hex-cli/wda-ports.json` 持久化）
- **UDID 安全**：所有子命令对 `--udid` 做 shell 元字符校验（防注入），仅允许 `[A-Za-z0-9._:-]`
- **默认 bundle-id**：iOS / Android = `com.alibaba.wireless`，HarmonyOS = `com.alibaba.wireless_hmos`；可通过 `--bundle-id` 临时覆盖
- **session TTL 7 天**：`hex device use` 写入的默认设备超过 7 天未在 daemon `/devices` 出现自动失效
- **不要绕过 `hex open`**：直接 `adb shell am start` 或 `hdc shell aa start` 不会注入 `Hex_Device_UDID`，端侧 WS 会以 `Build.SERIAL`（Android 10+ 是 `unknown`）或空值登录，导致 daemon 多出"幽灵设备"

## 完整参数参考

每个子命令的参数、默认值、行为细节、错误码映射 → [reference.md](reference.md)
