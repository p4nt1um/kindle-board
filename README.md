# kindle-board

把一台越狱后的旧款 Kindle 变成常驻的电子墨水看板：**本地服务负责取数，浏览器只负责显示**。

服务端是纯 Node 的局域网聚合服务，按 TTL 定时抓取多种数据源并缓存；服务端在电脑上跑通之后，迁移到一块闲置了若干年的树莓派（Raspberry Pi 3 Model B Rev 1.2）上，全天开机作为服务器。

Kindle 上的页面是一个严格 ES5 的「哑终端」，只做 XHR 取数与 DOM 文本更新。已在 Kindle 固件 5.16.2.1.1（600×800 / 16 级灰阶 / 旧 WebKit）上验证。

> 本项目不含任何凭据。所有 API Key、CalDAV 口令、云账号 AK/SK 都只放在服务端本地文件里，不会被下发到浏览器，也不会进入仓库。

---

## 效果预览

![Kindle 看板演示（600×800，纯 mock 数据）](docs/demo.png)

演示图由 [`docs/demo-payload.json`](docs/demo-payload.json) 渲染：双地区名称、日程、额度余额、天气、每日文案与图片**全部是虚构示例**，不含任何真实地点、日程、账户余额或凭据，占位图也由程序生成。版面为 时钟 → 天气 → 日程 / 每日 50/50 双栏 → 额度整宽横向 6 格；每日文字自然换行，图片说明在图片下方。

---

## 为什么这样设计

旧款 Kindle 的浏览器是老 WebKit：没有 `fetch` / `Promise`，没有 CSS Grid / Flex / `calc()`，根证书陈旧，也没有标准的 mDNS 解析器。把 API 密钥、CalDAV 凭据、时区换算、农历、ICS 解析、重复规则展开、图片下载都塞进页面，既不现实也不安全。

因此复杂度全部留在服务端：

- **服务端**：HTTPS 上游请求、签名、凭据、DST、农历、RRULE、图片缓存、失败隔离、stale 标记。
- **前端**：ES5 + XHR + 文本节点 diff，不整页重载；上游失败时保留上一次内容并标出「最后成功更新时间」。
- **DTO 契约**：每个板块统一返回 `{ ok, stale, updatedAt, lastAttemptAt, data, error }`。硬失败不推进 `updatedAt`，旧数据继续显示。

服务端不绑定 Windows：Windows PC、Linux 小主机、树莓派都能跑。

---

## 看板内容

| 板块 | 内容 | 数据源 |
| --- | --- | --- |
| 时钟 | 双时区、分钟级走时、真实 DST 偏移、标题行带公历 / 星期 / 农历 / 干支生肖 | Node `Intl`（完整 ICU） |
| 天气 | 两个时区各自当地的当天天气（纯 CSS 线条图标 + 最高/最低温）；点击任一地区，下方 5 日横排预报切换到该地区。预报含日期、天气、温度、降水概率 | Open-Meteo（城市列表与数据源可配置，免 Key） |
| 日程 | 最近若干条日程，含全天事件、进行中、重复规则展开 | 飞书 CalDAV（`calendar-query` + `calendar-multiget`） |
| 额度 | 整宽横向 6 个小格，每格「名称 / 标签 / 整数余额」三行纵排，只留数字、去掉说明文字；无金额时显示剩余百分比，失败显示 `—`，低余额给数字加下划线 | DeepSeek / Kimi / GLM、百度智能云 / 腾讯云 / 阿里云 |
| 每日 | 一句 / 一诗 / 一图，多源获取 + 本地回退；在双栏右栏时改为「上文下图」，文字完整不截断、自然换行，图片按栏宽放大且无边框，图片说明在图片下方 | 今日诗词、Hitokoto、iciba、Bing、Picsum 等 |

板块、顺序、刷新周期、低余额阈值、时区、天气城市列表都在 `config.json` 中配置；不需要的数据源留空凭据即可，板块会独立失败而不影响其它板块。当前默认版面是 **时钟 → 天气 → 日程 / 每日 50/50 双栏 → 额度整宽沉底**；前端 `isDuo()` 同时兼容 `agenda|quota` 旧配对，只改 `config.json` 的 `layout` 就能回滚到旧版面。

天气的两地数据在同一份 `board.json` 里一次下发，点击切换是纯前端本地行为，不产生额外请求；当前地区会显示在天气标题里，并给对应时钟加选中下边框。图标是纯 CSS 线条绘制（3px 线宽），不依赖 SVG、图标字体或外部图片，兼容旧 WebKit 与 16 级灰阶屏幕。天气上游可配主 / 备两个接口地址，单个城市的请求失败或返回异常结构时自动改用备用地址，两地各自独立尝试；板块整体失败后服务端最多 10 分钟重试一次，不会因一次冷启动失败空白数小时。

**刷新页面**：5 分钟轮询只拉 JSON、局部改文本，不会重载静态资源。要看新版 `board.css` / `board.js` 有两种主动重载方式：① 点按右下角每日一图 → 弹出大图 → 5 秒后整页刷新（点弹窗可立即刷新）；② 改服务端 `data/reload-token` 里那一行，浏览器下一次轮询发现 `server.reloadToken` 变化就自动整页重载。后者用于远程发版，不用重启服务、也不用碰设备。静态资源带 `Cache-Control: no-store`，重载一定拿到新代码。注意区分两类改动：`config.json` 被服务端 `require()` 缓存，改 `layout` / 阈值 / 城市等配置后**必须重启服务**；只改 `board.css` / `board.js` 属于静态资源发版，换 `data/reload-token` 即可，无需重启。

---

## 架构

```
   公网 HTTPS / 签名 API                本地聚合服务 (Node)              Kindle 浏览器
  ┌──────────────────────┐        ┌────────────────────────┐      ┌──────────────────┐
  │ 天气 / CalDAV / 额度  │  ◀──▶  │ fetchers (带 TTL 缓存)  │      │  ES5 + XHR       │
  │ 一言 / 一诗 / 图片    │        │ aggregator (stale/DTO) │ ───▶ │  文本节点 diff   │
  └──────────────────────┘        │ HTTP + 静态白名单       │      │  无 Grid/Flex    │
                                  │ mDNS 公告 / 发现链      │      └──────────────────┘
   凭据仅在服务端可见  ──────────▶  └────────────────────────┘        仅展示文本
```

服务端只监听局域网。浏览器拿到的是字段白名单投影后的展示数据，看不到任何密钥、签名串或原始上游响应。

---

## 快速开始

### 环境要求

- **Node.js >= 18**，且带完整 ICU（农历用 `zh-CN-u-ca-chinese`；可用 `npm run preflight` 检查）
- 一台与 Kindle 处于同一局域网的机器（Windows / Linux / 树莓派均可）
- 已越狱、能用内置浏览器访问局域网 HTTP 的 Kindle

### 安装与启动

```bash
git clone https://github.com/p4nt1um/kindle-board.git kindle-board
cd kindle-board
npm install
cp secrets.example.json secrets.local.json
# 编辑 secrets.local.json，填入需要的凭据；不用的板块留空即可
npm start
```

服务默认监听 `0.0.0.0:8787`。启动日志会打印候选访问地址与运行信息（Node 版本、ICU、局域网网卡）。

### 打开看板

在 Kindle 浏览器访问 `http://<服务机的局域网地址>:8787/`。

`/probe.html` 会逐个实测候选地址、报告浏览器能力（`fetch` / `Promise` / Grid / Flex 等）并给出建议书签。

> **旧 Kindle 通常无法解析 `.local` 域名**（缺 mDNS resolver），最可靠的入口是直连 IP。建议给服务机在路由器上做一条 DHCP 静态保留，这样书签地址稳定，而服务端配置里仍然不需要写死任何 IP。

---

## 配置

| 文件 | 作用 | 是否入库 |
| --- | --- | --- |
| `config.json` | 非敏感参数：端口、刷新周期、时区、板块顺序、天气城市列表（key 对齐时区 id）与上游主 / 备地址、阈值、发现链 | ✅ |
| `secrets.example.json` | 全部凭据键名的空模板 | ✅ |
| `secrets.local.json` / `secrets.json` | 实际凭据，权限建议 `600` | ❌ 已忽略 |
| `.env` / `deploy/env` | systemd 环境变量文件 | ❌ 已忽略 |
| `data/` | 运行缓存、每日一图、素材池 | ❌ 已忽略 |
| `data/reload-token` | 一行纯文本的刷新令牌；改它即可让 Kindle 自动整页重载拿新版前端，无需重启服务 | ❌ 已忽略 |

凭据也可通过环境变量注入（`DEEPSEEK_API_KEY`、`KIMI_API_KEY`、`BAIDU_CLOUD_AK` 等，完整映射见 `server/secrets.js`）。优先级为 **环境变量 > 凭据文件规范键名 > 别名 / 归一化兜底**；凭据文件按 mtime 热加载，改环境变量或 systemd unit 才需要重启服务。

`npm run sync-secrets` 可把当前进程环境变量合并写入凭据文件（不会清空已有键；`--prune` 才会清理）。

### 主要接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/board.json` | 全部板块的展示数据（字段白名单投影） |
| `GET /api/health` | 服务状态、凭据「有无」、各板块成功/过期状态（不含任何值） |
| `GET /api/discovery` | 动态候选访问地址，随 DHCP 变化自动更新 |
| `POST /api/refresh` | 强制刷新；默认只允许本机调用 |

---

## 二次开发

板块通过注册表描述：`{ id, title, rows, ttl, realtime, renderer, fetcher }`。

1. 在 `server/fetchers/` 加一个取数模块，返回统一的展示 DTO；
2. 在 `server/blocks.js` 注册；
3. 在 `public/board.js` 的 `BUILDERS` / `RENDERERS` 里建骨架并只改文本节点；
4. 在 `config.json` 的 `layout` 中加入该板块（想让它参与双栏，还需在 `public/board.js` 的 `isDuo()` 里登记相邻配对）。

**约定**：看起来是纯展示的规则（是否当天、金额是否低于阈值、是否进行中）也由服务端算好并下发布尔量，前端只切 `className`。这样哑终端不需要理解业务，也便于写离线自检。

改动服务端代码或 `config.json` 后需要重启服务（`require()` 有缓存）；改凭据文件则会自动热加载；只改前端静态资源换 `data/reload-token` 即可。

---

## 部署到 Linux / 树莓派

运行时主代码没有 Windows 绑定，Windows 专属内容只在运维脚本层。

```bash
npm run preflight      # ICU / 时区 DST / 加密 / 网卡 / 凭据权限 / NTP 等环境自检
npm start              # 先前台跑通
```

`deploy/` 提供了可直接改造的模板：

- `kindle-board.service` —— 系统级 systemd unit
- `kindle-board-user.service` —— **无需 root** 的用户级 unit（含 `NoNewPrivileges`、`PrivateTmp`、`UMask=0077`、内存上限，以及开机等待 NTP 同步的 `ExecStartPre`）
- `env.example` / `env.raspberry-pi.example` —— 环境变量模板（只指定网卡名，不写 IP）
- `timesyncd-10-local.conf` —— 国内 NTP 源 drop-in 示例

树莓派没有硬件 RTC，云 API 签名（BCE 要求 UTC ±1800 s）与 TLS 校验都依赖正确时间，请确保 NTP 正常。服务只监听局域网，**不要做公网端口映射**。

---

## 自检与诊断

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 全部 JS 语法检查 |
| `npm run check:secrets` | 扫描会被提交的文件是否含疑似凭据（只报文件名/类型，不打印值） |
| `npm run selftest` | 多套离线回归：日程解析、三家云签名、额度条件格式、前端 DOM（含双栏配对、额度 6 格拆字、布局回滚、双地区天气切换与主动刷新）、多城市天气取数（含主备上游回退）、凭据键名兼容 |
| `npm run preflight` | 运行时环境自检，不联网、不读凭据 |
| `npm run diagnose` | 联网诊断 CalDAV 结构（不输出凭据与日程标题） |
| `npm run diagnose:baidu` | 诊断百度云余额签名链路（输出脱敏） |

自检全部离线运行、使用假值，不需要真实凭据。

---

## 安全设计

- **凭据隔离**：密钥只存在于服务端；`board.json` 逐字段白名单投影，签名串、AK/SK、`Authorization` 不会下发。
- **哑终端**：页面只接收展示文本，不承担任何签名或鉴权逻辑。
- **失败隔离**：单个上游失败不影响其它板块，也不清空已有内容。
- **局域网只读**：`/api/refresh` 默认仅本机可调用；静态文件走白名单。
- **仓库防呆**：`.gitignore` 排除凭据、运行数据、环境变量与私有笔记；提交前 hook 扫描疑似凭据，命中即中止。

注意 `.gitignore` 挡的是文件，不是文字——提交前请确认文档里没有写入自己环境的内网信息或账号数据。

---

## 已知限制

- 旧 WebKit 没有 mDNS 解析器，`.local` / 短名通常不可用；请用直连 IP 或自建本地 DNS 记录。
- 云账户余额使用各家签名协议（BCE v1 / TC3-HMAC-SHA256 / RPC HMAC-SHA1），需要自备**只读** AK/SK；接口变更时会以 `ok=false` 显示而不是伪装成 0。
- 飞书 CalDAV 需两步取数，且 XML 中的换行会被编码为数字实体，本项目已做结构级失败判定，避免 HTTP 200 却静默清空日程。
- 无 RTC 设备开机时间可能需要 NTP 校正，服务已内置等待逻辑。
- 600×800 / 16 灰阶的实际观感建议在目标设备上自行微调 `public/board.css`。

---

## 目录结构

```
kindle-board/
├── server/
│   ├── index.js            # HTTP 入口、API 路由、服务发现
│   ├── aggregator.js       # TTL 调度、stale、DTO 投影
│   ├── blocks.js           # 板块注册表
│   ├── secrets.js          # 凭据层（仅服务端）
│   ├── mdns.js             # 局域网公告与网卡选择
│   ├── http-util.js        # 上游请求封装（超时/脱敏/重定向）
│   ├── fetchers/           # 各板块取数与签名实现
│   ├── check-secrets.js    # 提交前凭据扫描
│   └── selftest-*.js       # 离线回归
├── public/                 # ES5 哑终端页面与样式
├── deploy/                 # systemd / env / NTP 模板
├── config.json             # 非敏感配置
└── secrets.example.json    # 空凭据模板
```

---

面向公开读者的介绍就到这里。部署过程、真机排查记录与本机运维笔记不随仓库发布；维护自己的部署记录时可放在 `README.local.md` 或 `NOTES.md`（两者均已被忽略）。

---

## 许可

[MIT License](LICENSE) · Copyright (c) 2026 p4nt1um
