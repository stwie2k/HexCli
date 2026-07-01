# Hex CLI 人工测试用例

> 版本：v3.0.x
> 适用范围：`@ali/hexcli` 全部命令、Daemon 生命周期、iOS / Android / HarmonyOS 三端、单设备 / 多设备场景
> 执行方式：人工手动验证，按 **前置条件 → 操作步骤 → 预期结果** 逐项核对

---

## 0. 测试环境准备

### 0.1 基础环境
| 项 | 要求 |
|---|---|
| OS | macOS 12+ |
| Node.js | ≥ 16 |
| Xcode | ≥ 14（含 Command Line Tools） |
| iOS 设备 | iOS 14+，已信任开发者，**已安装目标 App** |
| Android 设备 | Android 8+，**已开启 USB 调试**，**已安装目标 App** |
| ADB | `adb devices` 可识别 |
| `xcrun xctrace` | `xcrun xctrace list devices` 可识别 |
| HarmonyOS 设备 | 鸿蒙设备已通过 USB 连接或模拟器已启动 |
| `hdc` | `hdc list targets` 可识别 |

### 0.2 安装 / 升级
```bash
npm i -g @ali/hexcli --registry=$HEX_NPM_REGISTRY
hex --version    # 输出 3.0.x
```

---

## 1. CLI 基础 / 帮助

| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| BASE-01 | 查看版本 | `hex --version` | 输出 `3.0.x`，进程退出码 0 |
| BASE-02 | 查看帮助 | `hex --help` 或 `hex -h` | 输出按分组（会话生命周期 / 多设备路由 / 环境与配置 / 设备交互 / 调试 / CLI 维护）展示的命令列表 |
| BASE-03 | 无参运行 | `hex` | 输出与 `--help` 一致 |
| BASE-04 | 无效命令 | `hex foobar` | 报错提示 `unknown command`，退出码非 0 |
| BASE-05 | 子命令帮助 | `hex env --help`、`hex device --help`、`hex mock --help`、`hex query --help` | 各自打印自己的子命令与参数说明 |
| BASE-06 | 全局 udid 选项 | `hex --udid abc123 --help` | 不报错，`--udid` 在 root 层可被解析 |

---

## 2. CLI 维护命令

### 2.1 `hex doctor`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| DOC-01 | 环境检查 | `hex doctor` | 表格输出各项检查（Node / Xcode / xcrun / adb / WebDriverAgent / iproxy 等），**全部 ✓** 或对失败项给出修复建议 |
| DOC-02 | 缺失项提示 | 临时把 `adb` 从 PATH 移除后执行 `hex doctor` | adb 一项变 ✗，给出安装/配置建议（不影响其他项） |
| DOC-03 | 进程退出码 | `hex doctor && echo $?` | 全 pass 时为 0；有 critical 失败时非 0 |

### 2.2 `hex update`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| UPD-01 | 升级到最新 | `hex update` | 自动执行 `npm i -g @ali/hexcli@latest --registry=...`，结束后 `hex --version` 更新 |
| UPD-02 | 已是最新 | 再次执行 `hex update` | 提示 "已是最新版本"（或类似），无错误退出 |

### 2.3 `hex doc`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| DOC-DOC-01 | 打开文档 | `hex doc` | 浏览器打开 HexCli 文档站（static 项目对应的 URL） |

---

## 3. 会话生命周期

### 3.1 `hex open`
| ID | 用例 | 前置 | 步骤 | 预期结果 |
|---|---|---|---|---|
| OPEN-01 | 单设备自动连接 | 仅 1 台设备（iOS 或 Android）已连接 | `hex open` | Daemon 自动启动 → WebSocket 监听 12588 → App 自动拉起 → 收到 hello 帧 → 终端打印 "已连接 设备名 (udid)" |
| OPEN-02 | 多设备未指定 udid | 同时连接 iOS + Android | `hex open` | 报错：要求显式 `--udid`，并**列出所有可选 udid** |
| OPEN-03 | 多设备指定 udid | 多设备 | `hex open --udid <ios-udid>` | 仅对该设备 open；未指定的设备保持空闲 |
| OPEN-04 | 全局 udid | 多设备 | `hex --udid <udid> open` | 与 OPEN-03 等价，全局选项穿透生效 |
| OPEN-05 | 非法 udid | 任意 | `hex open --udid not-exist` | 报错：找不到该设备 |
| OPEN-06 | 已 open 重复执行 | 已 open 状态 | 再次 `hex open` | 幂等：检测到已建立会话，直接返回成功（或重新拉起 App） |
| OPEN-07 | Daemon 已存在 | Daemon 在运行 | `hex open` | 直接复用，不重启 Daemon |
| OPEN-08 | App 未安装 | 设备没装目标 App | `hex open` | 报错提示 "未安装 / 启动失败"，且不影响其他命令 |

### 3.2 `hex stop`
| ID | 用例 | 前置 | 步骤 | 预期结果 |
|---|---|---|---|---|
| STOP-01 | 标准停止 | 已 open | `hex stop` | App 退出 / WDA 退出 / Daemon 关闭 / `~/.hexcli/daemon.json` 清理 |
| STOP-02 | verbose 模式 | 已 open | `hex stop -v` | 输出详细进度（停止 Daemon、kill iproxy、kill WDA、清理 PID …） |
| STOP-03 | 重复 stop | 无 Daemon | `hex stop` | 友好提示 "无运行中会话"，退出码 0 |
| STOP-04 | stop 后再 open | `hex stop` → `hex open` | open 全流程重新走通，无脏状态 |

---

## 4. 多设备路由（`hex device`）

### 4.1 `hex device list`
| ID | 用例 | 前置 | 步骤 | 预期结果 |
|---|---|---|---|---|
| DEV-LIST-01 | 仅本地 USB 设备 | Daemon 未启动，1 台 iOS + 1 台 Android | `hex device list` | 自动启动 Daemon → 表格列出 2 台设备，status 列为 `connected`（未 online） |
| DEV-LIST-02 | 含在线设备 | 已 `hex open` 一台 | `hex device list` | 该台 status 为 `online`（含 appVersion、connectedAt），其他 USB 设备为 `connected` |
| DEV-LIST-03 | 无线设备 | 仅 Daemon 在线但未 USB 连接（如 WiFi 调试） | `hex device list` | 该设备仍出现，status `online`，platform 字段正确 |
| DEV-LIST-04 | 无任何设备 | 拔掉所有设备 | `hex device list` | 表格为空，提示 "未检测到设备" |

### 4.2 `hex device use <udid>` / `hex device clear`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| DEV-USE-01 | 设默认 | `hex device use <udid>` | 提示 "默认设备已设为 …"，写入 `~/.hexcli/session.json` |
| DEV-USE-02 | 默认设备生效 | 多设备 + 已 use → `hex env online` | 不需要 `--udid`，自动作用于默认设备 |
| DEV-USE-03 | 非法 udid | `hex device use not-exist` | 报错（建议先 list） |
| DEV-USE-04 | 清除默认 | `hex device clear` | 提示 "已清除"；之后多设备执行命令需要重新 `--udid` |

### 4.3 `hex device disconnect <udid>`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| DEV-DC-01 | 断开指定 | `hex device disconnect <udid>` | 该 udid 的 WebSocket 被关闭，`hex device list` 中状态由 online 变为 connected（仍 USB），其他设备会话不受影响 |
| DEV-DC-02 | 断开未连接的 udid | `hex device disconnect not-online` | 友好提示，退出码 0 |

---

## 5. 环境与配置

### 5.1 `hex env` — 环境切换
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| ENV-01 | 切预发 | `hex env pre` | App 自动重启 → 进入 pre 环境（在 App 内确认 env=pre） |
| ENV-02 | 切线上 | `hex env online` | App 重启 → online 环境 |
| ENV-03 | 灰度开 | `hex env gray --on` | 命令成功；App 内灰度生效 |
| ENV-04 | 灰度关 | `hex env gray --off` | 同上反向 |
| ENV-05 | 灰度参数互斥 | `hex env gray --on --off` | 报错（参数冲突）或行为以最后一个为准（按当前实现验证） |
| ENV-06 | 灰度缺参 | `hex env gray` | 报错 / 提示需指定 `--on` 或 `--off` |
| ENV-07 | 降级开关 | `hex env downgrade --on` / `--off` | 同 ENV-03/04 |
| ENV-08 | CyberT 开关 | `hex env cybert --on` / `--off` | App 内 CyberT 调试状态切换 |
| ENV-09 | 全域名白名单 | `hex env whitelist --on` / `--off` | App 内白名单总开关切换 |
| ENV-10 | HTTPS 降级 | `hex env https-downgrade --on` / `--off` | 切换成功 |
| ENV-12 | 多设备 udid | `hex env online --udid <udid>` | 仅作用于指定设备 |

### 5.2 `hex whitelist <host>`（顶层域名添加）
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| WL-01 | 添加单域名 | `hex whitelist example.com` | 提示 "已添加白名单域名: example.com" |
| WL-02 | 含端口 | `hex whitelist example.com:8080` | 添加成功 |
| WL-03 | 缺参 | `hex whitelist` | 报错：缺少 `<host>` |

### 5.3 `hex redirect`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| RD-01 | urlToUrl | `hex redirect --type urlToUrl --source https://a.com/x --target https://b.com/y` | 提示设置成功；App 实际请求 a.com/x 被转到 b.com/y |
| RD-02 | pathToUrl | `hex redirect --type pathToUrl --source /api/foo --target https://mock.com/foo` | 任意域名下 `/api/foo` 命中 |
| RD-03 | regexToUrl | `hex redirect --type regexToUrl --source ".*\.png$" --target https://cdn.x/test.png` | 所有 png 资源都被替换 |
| RD-04 | 非法 type | `hex redirect --type wrong --source a --target b` | 报错列出合法值 |
| RD-05 | 缺必填 | `hex redirect --type urlToUrl --source x` | commander 报错缺 `--target` |

### 5.4 `hex mock`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| MOCK-01 | 初始化 | 删除 `~/.hexcli/mock.json` 后 `hex mock init` | 生成模板，含示例规则 |
| MOCK-02 | 重复 init | `hex mock init` 再次 | 提示已存在 / 询问覆盖（按实现验证） |
| MOCK-03 | show 摘要 | `hex mock show` | 打印本地规则，长字符串被截断 |
| MOCK-04 | show 完整 | `hex mock show -f` | 打印完整内容，无截断 |
| MOCK-05 | apply 下发 | 编辑 mock.json 加入规则 → `hex mock apply` | 提示 "已下发"，App 内对应接口命中 mock |
| MOCK-06 | apply 多设备 | `hex mock apply --udid <udid>` | 仅作用指定设备 |
| MOCK-07 | clear | `hex mock clear` | 设备端 mock 被清空，本地 mock.json 不变 |
| MOCK-08 | apply 非法 JSON | mock.json 故意写错 → `hex mock apply` | 报错并指出文件路径 / 行号（或类似） |

### 5.5 `hex query`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| QRY-01 | orange | `hex query orange <groupName>` | 输出该 group 的 orange 配置 JSON |
| QRY-02 | orange 缺参 | `hex query orange` | commander 报错缺 `<groupName>` |
| QRY-03 | ab 必填 | `hex query ab --component CartButton` | 输出 AB 信息 |
| QRY-04 | ab + module | `hex query ab --component X --module Y` | 同上，带模块过滤 |
| QRY-05 | ab 缺 component | `hex query ab` | commander 报错 `--component` 必填 |
| QRY-06 | cookie 默认 | `hex query cookie` | 输出原生 cookie |
| QRY-07 | cookie webview | `hex query cookie --web --url https://m.1688.com` | 输出 webview cookie |
| QRY-08 | lastpageapm | 在 App 内任意翻页 → `hex query lastpageapm` | 输出上个页面性能 |
| QRY-09 | launchapm | App 冷启动后 → `hex query launchapm` | 输出启动 APM |
| QRY-10 | appinfo | `hex query appinfo` | 输出 version / build / bundleId / sdkVersion 等 |

---

## 6. 设备交互

### 6.1 `hex login`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| LOGIN-01 | 正常登录 | `hex login --havana-id <id> --sso-key <key>` | App 完成登录，显示已登录态 |
| LOGIN-02 | 缺 sso-key | `hex login --havana-id <id>` | commander 报错必填 |
| LOGIN-03 | 错误凭证 | 使用错误 key | App 端报登录失败，CLI 输出错误信息 |

### 6.2 `hex tap` / `hex swipe`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| TAP-01 | 普通点击 | `hex tap -x 200 -y 400` | 设备屏幕对应位置触发点击 |
| TAP-02 | 长按 | `hex tap -x 200 -y 400 --duration 1500` | 长按 1.5s |
| TAP-03 | 缺参 | `hex tap -x 100` | commander 报错缺 `-y` |
| TAP-04 | 非法坐标 | `hex tap -x abc -y 100` | 报错坐标必须为数字 |
| TAP-05 | 多设备 udid | `hex tap -x 100 -y 200 --udid <udid>` | 仅指定设备生效 |
| SWP-01 | 经典上滑 | `hex swipe -x 200 -y 800 --x2 200 --y2 200` | 设备页面向下滚动 |
| SWP-02 | from/to 简写 | `hex swipe --from 200,800 --to 200,200` | 等价 SWP-01 |
| SWP-03 | 自定义时长 | `hex swipe --from 200,800 --to 200,200 --duration 1200` | 滑动慢一倍 |
| SWP-04 | from 格式错 | `hex swipe --from 200 --to 200,200` | 报错格式应为 `x,y` |

### 6.3 `hex back`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| BACK-01 | 触发返回 | 任意非首页页面 → `hex back` | 设备返回上一页 |
| BACK-02 | 根页面 | App 处于首页 → `hex back` | iOS：通常无反应或退到桌面（按实现）；Android：退出 App / 无反应 |

### 6.4 `hex screenshot`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| SCR-01 | 默认输出 | `hex screenshot` | 截图保存到默认路径（如 `~/.hexcli/screenshots/xxx.png`），打印路径 |
| SCR-02 | 指定路径 | `hex screenshot -o ./shot.png` | 文件落到当前目录 `shot.png` |
| SCR-03 | 路径不存在 | `hex screenshot -o /tmp/nope/shot.png` | 自动创建目录或报错（按实现） |
| SCR-04 | 多设备 | `hex screenshot --udid <udid>` | 截取指定设备 |
| SCR-05 | iOS 横屏 / 竖屏 | 切换设备方向各截一次 | 图片方向与屏幕一致 |
| SCR-06 | Android 截图 | Android 设备 + `hex screenshot` | 成功输出 png |

### 6.5 `hex open-url <url>`
| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| OURL-01 | http 链接 | `hex open-url https://m.1688.com` | App 内跳转到该页 |
| OURL-02 | scheme 链接 | `hex open-url alibaba://...` | App 路由命中 scheme |
| OURL-03 | 缺参 | `hex open-url` | commander 报错缺 `<url>` |
| OURL-04 | 非法 URL | `hex open-url not_a_url` | 设备端无响应或 toast 错误（按 App 实现） |

---

## 7. 实时调试 `hex debug`

| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| DBG-01 | 监听 mtop | `hex debug --type mtop` | 实时打印设备 mtop 请求 / 响应 |
| DBG-02 | 多类型 | `hex debug --type mtop,ut,app` | 多类型混合输出 |
| DBG-03 | 非法 type | `hex debug --type unknown` | 报错或忽略未知类型并提示合法值 |
| DBG-04 | 后台模式 | `hex debug --type mtop &`（或对应 worker 形式） | 后台 worker 启动，前台立即返回 |
| DBG-05 | 查看状态 | `hex debug --status` | 输出当前 worker PID / 监听 type / 持续时长 |
| DBG-06 | 停止 worker | `hex debug --stop` | worker 退出，再次 `--status` 显示无运行 |
| DBG-07 | 多设备 | `hex debug --type mtop --udid <udid>` | 仅监听该设备推送 |
| DBG-08 | Ctrl+C 退出 | 前台运行中按 Ctrl+C | 优雅退出，不留僵尸进程 |
| DBG-09 | 设备断开自动重连 | 运行中拔插 USB | 连接恢复后自动续传（或友好报错） |

---

## 8. 全局选项 `--udid`

| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| GUDID-01 | 顶层 --udid | `hex --udid <udid> env pre` | 等价于 `hex env pre --udid <udid>` |
| GUDID-02 | 顶层 vs 子命令冲突 | `hex --udid A env pre --udid B` | 子命令的 `--udid` 优先（按实现确认） |
| GUDID-03 | 默认设备覆盖 | 已 `device use A`，执行 `hex --udid B env pre` | B 生效，A 被覆盖 |

---

## 9. Daemon 行为

| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| DM-01 | 端口占用 12588 | 提前 `nc -l 12588`，再 `hex open` | 报错端口被占用，给出处理建议 |
| DM-02 | 端口占用 12589 | 同上对 12589 | 同上 |
| DM-03 | Daemon 异常退出 | `kill -9 $(cat ~/.hexcli/daemon.pid)` 后执行任意命令 | 自动检测过期 → 重启 Daemon |
| DM-04 | `~/.hexcli/daemon.json` 损坏 | 手动改坏后执行命令 | 自动重建 / 报错并提示 reset |
| DM-05 | 多终端并发 | 终端 A `hex open`，终端 B `hex env pre` | B 复用同一 Daemon，命令成功 |

---

## 10. 跨平台行为

| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| CP-01 | iOS only 命令 | iOS 设备执行 `hex screenshot` | 通过 WDA 截图 |
| CP-02 | Android only 命令 | Android 设备执行 `hex screenshot` | 通过 adb 截图 |
| CP-03 | 同命令双端 | iOS + Android 分别 `hex env pre` | 行为一致，App 都重启切环境 |
| CP-04 | 坐标单位 | iOS pt vs Android dp vs HarmonyOS vp，`hex tap -x 100 -y 200` | 三端点击位置在视觉上对齐 |
| CP-05 | 中文路径 | `hex screenshot -o "./截图.png"` | 文件正常生成 |
| CP-06 | HarmonyOS screen | HarmonyOS 设备执行 `hex screen` | 输出 `vp` 单位，如 `1379x1967 vp @1.61875x` |
| CP-07 | HarmonyOS inspect | HarmonyOS 设备执行 `hex inspect` | 输出树形视图树，含组件类型和 vp 坐标 |
| CP-08 | HarmonyOS inspect --json | `hex inspect --json` | 输出合法 JSON，可被 jq 解析 |
| CP-09 | HarmonyOS tap --text | `hex tap --text "设置"` | 找到元素并点击 |
| CP-10 | HarmonyOS 坐标联动 | inspect 输出坐标 → tap 使用 | 点击位置正确 |

---

## 11. 异常 & 边界

| ID | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| ERR-01 | 设备中途拔出 | 命令执行中拔掉 USB | 友好报错，Daemon 不崩溃 |
| ERR-02 | App 中途崩溃 | App 主动 kill 后执行 `hex env pre` | 报错 "App 未运行" 或自动拉起（按实现） |
| ERR-03 | 网络断开 | 关闭 WiFi 执行 `hex update` | 拉取失败，提示重试 |
| ERR-04 | 权限不足 | `hex screenshot -o /shot.png`（无写权限路径） | 报错 EACCES |
| ERR-05 | 超大 mock.json | 1MB+ mock.json `hex mock apply` | 成功下发或友好提示 payload 过大 |
| ERR-06 | 命令长时间无响应 | 设备死机时执行 `hex tap ...` | 超时后报错（不会无限挂起） |

---

## 12. 回归 / 冒烟（每次发版必跑）

| 序号 | 命令 | 预期 |
|---|---|---|
| 1 | `hex --version` | 输出版本号 |
| 2 | `hex doctor` | 全项 pass |
| 3 | `hex device list` | 至少列出 1 台设备 |
| 4 | `hex open` | 连接成功 |
| 5 | `hex env pre` | App 切预发并重启 |
| 6 | `hex query appinfo` | 输出 App 元信息 |
| 7 | `hex screenshot -o ./smoke.png` | 文件存在且可打开 |
| 8 | `hex tap -x 100 -y 200` | 设备屏幕点击有响应 |
| 8.1 | `hex tap --text "设置"` | 找到文本元素并点击 |
| 8.2 | `hex screen` | 输出屏幕宽高（pt/dp/vp） |
| 8.3 | `hex inspect` | 输出视图树 |
| 9 | `hex mock init` → `apply` → `clear` | 三步均无报错 |
| 10 | `hex debug --type mtop`（5s 后 Ctrl+C） | 有数据输出，优雅退出 |
| 11 | `hex stop` | 完全清理 |

---

## 附录 A — 多设备场景一览

| 场景 | 推荐命令 |
|---|---|
| 临时一次性指定 | `hex <cmd> --udid <udid>` |
| 长期默认设备 | `hex device use <udid>` 一次，后续命令免输 |
| 临时跨命令穿透 | `hex --udid <udid> <cmd>` |
| 同时调试两台 | 终端 A `hex --udid A open`，终端 B `hex --udid B open` |

## 附录 B — 关键文件 / 路径

| 路径 | 用途 |
|---|---|
| `~/.hexcli/daemon.json` | Daemon 元信息（pid、wsPort、ipcPort） |
| `~/.hexcli/daemon.pid` | Daemon 进程 PID |
| `~/.hexcli/session.json` | 默认设备 udid |
| `~/.hexcli/mock.json` | 本地 mock 规则 |
| `~/.hexcli/screenshots/` | 默认截图保存目录 |

## 附录 C — 报告 Bug 模板

```
【环境】
- macOS: 
- Node: 
- hexcli: 
- 设备：iOS xx / Android xx

【复现命令】

【预期】

【实际】

【日志】（hex doctor + 命令输出）
```
