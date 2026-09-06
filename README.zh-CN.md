# DSH Image2 生图插件（gpt-image-2）

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-web%20profile-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-brightgreen)

为 [DeepSeek Harness](https://github.com/deepseek-ai) 增加 **Image2（`gpt-image-2`）生图能力**：
通过任意 **OpenAI Images 兼容**的中转接口，即可在对话中使用文生图与图生图。只需配置
`baseURL` 和 `API Key`；生成的图片直接显示在聊天里（缩略图、放大、另存为），同时保存到
`outputs/image2/`。

> **社区 fork 说明**：本仓库是 MIT 协议项目 [JuneLearn/dsh-image2-draw](https://github.com/JuneLearn/dsh-image2-draw)
> 的维护分支，在原作者基础上修复了网关兼容性问题并新增图形化生图工作台（见 [本分支改动](#本分支改动)）。
> 原作者的版权与许可证完整保留在 [LICENSE](./LICENSE)。

**一键安装**（任选一行，粘贴到终端回车）：

```bash
# 已装好 DSH（Web 版）：
dsh plugin --profile web add github:oebeliever/dsh-image2-draw

# 全新机器一键装（自动装 Node/pnpm/DSH）：
# Windows PowerShell:
irm https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.ps1 | iex
# macOS / Linux:
curl -fsSL https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.sh | bash
```

装完重启 DSH（`dsh web`），打开 **设置 → 插件 → 插件配置 → Image2 生图**，填入中转站的
`API Key` 与接口地址（如 `https://example.com/v1`，自动补全 `/images/generations`），
新建会话让 AI 调用 `image2-generate` 即可出图。[English](./README.md)

---

## 目录

- [功能](#功能)
- [本分支改动](#本分支改动)
- [🎨 生图工作台](#-生图工作台)
- [环境要求](#环境要求)
- [安装](#安装)
- [升级与卸载](#升级与卸载)
- [使用](#使用)
- [图片与请求限制](#图片与请求限制)
- [常见问题 FAQ](#常见问题-faq)
- [开发](#开发)
- [致谢](#致谢)
- [License](#license)

## 功能

- 在“设置 > 插件 > 插件配置”中提供独立的 **Image2 生图**配置卡片；
- 只需配置 `baseURL` 和 `API Key`；默认模型为 `gpt-image-2`；
- `baseURL` 可填 `https://example.com/v1` 简写，插件自动补全 `/images/generations`；
- 图生图端点默认由 `baseURL` 推导为 `/images/edits`，也可单独配置 `editURL`；
- `image2-generate` 文生图：一次可生成 1~8 张，逐张顺序请求，不并发；
- `image2-edit` 图生图：支持 1~8 张 PNG / JPEG / WebP 参考图；
- 尺寸：支持按提示词方向词自适应 / `auto` 直通 / 网关通用预置
  （`1024x1024`、`1536x1024`（横）、`1024x1536`（竖）、`3840x2160` 等）/ 校验过的自定义
  `宽x高`（16 的倍数、最长边 ≤3840、总像素 655,360~8,294,400、宽高比 ≤3:1）；
- 质量档位：`low` / `medium` / `high` / `auto`（是否生效取决于中转实现）；
- 聊天内专用工具卡片：缩略图、点击放大、另存为；图片同时保存到会话工作目录
  `outputs/image2/image2-<时间戳>[-N].<扩展名>`，重名自动编号不覆盖；
- **🎨 生图工作台**（聊天输入框上方）：文生图 / 图生图（点击或拖拽上传 1~8 张参考图）/
  **多视角人物**（上传同一人物 2~8 张不同视角照片 → 保持其五官、身材、发型一致地生成新图），
  后台任务轮询、结果画廊即时预览与另存；工作台产物保存在
  `~/.dsh/storages/image2-draw/library/`（重启 dsh 后仍可访问）；
- API Key 只写入 DSH credentials（或环境变量 `IMAGE2_API_KEY`），不进普通设置文档、
  不会由插件状态接口返回；
- 对配置写入、响应大小、超时和参考图文件实施校验；HTTP 524 与超时**不会自动重试**，
  避免上游已生成图片时重复计费。

## 本分支改动

**v0.2.1（提示词库 / 功能库）**

1. **内置模板**：人物设计图「版式A（脸部特写 + 赤膊体型 + 动作）」与「版式B（穿着局部特写）」
   两套提示词（`{outfit}` 变量）；「同人多视角 → 全套人物设计图」逐套确认流程；
   「六套着装清单（含英文 outfit 描述）」；
2. **用户自定义模板库**：持久化于 `~/.dsh/storages/image2-draw/presets.json`；🎨 工作台
   内新增「📚 模板库」：一键载入（自动识别 `{变量}` 并弹出填写）、把当前提示词“＋存为模板”、
   流程/清单类模板可预览复制、自定义模板可删除；
3. **对话可用**：新工具 `image2-preset`（list / get / save）——需要“人物设计图”时直接让
   AI 读取内置流程或你的自定义模板执行（逐张生成、每张等你确认后继续）。

**v0.2.0（新增：文档对齐 + 生图工作台）**

1. **尺寸体系对齐 OpenAI Images 规格**（常见 OpenAI 兼容中转如 zzz 仅接受列表内尺寸）：
   显式 `auto` 直通上游；竖/横预置由旧 `768x1024 / 1024x768` 改为网关通用
   `1024x1536 / 1536x1024`；`1024x1024 / 1536x1024 / 1024x1536 / 3840x2160` 等预置尺寸
   直接放行，不再做无谓校验；
2. **图生图改为标准多源图语义**：多张参考图一律重复发送标准 `image` 字段
   （不再使用非标准的 `image[]`），支持“多张不同角度人物照 → 保持同一人物生成”；
   `refs` 还支持直接传**对话中已上传图片的附件 id（`sha256:` 开头）**——插件自动从
   附件库读取，无需本地路径、无需调用任何识图/读图工具；
3. **新增 🎨 生图工作台**（聊天输入区 dock）：文生图 / 图生图 / 多视角人物三个页签，
   点击与拖拽上传（PNG/JPEG/WebP，≤4MB/张、≤8 张）、多视角模式可一键组装
   “人物一致性”提示词、后台任务轮询生成、结果画廊预览 + 另存为；
4. **密钥缺失提示更明确**：提示中转若按分组隔离模型（如 openai / Image 分组），
   请使用其 **Image/图片 分组** 的密钥。

**v0.1.1（对比上游 v0.1.0）**

1. **移除请求中的非标准 `output_format` 字段**：部分 OpenAI 兼容网关会拒绝该参数，
   现只发送标准字段（`model/prompt/size/quality/n`）；
2. **重定向显式处理（`redirect: 'manual'`）**：上游 3xx 会给出明确诊断，其中
   `region-unavailable`（地区不可用）会提示“当前网络出口 IP 被该服务商限制（通常为
   中国大陆地区封锁），请改用海外代理节点并重启 GUI，或更换支持当前地区的中转服务”；
3. **更友好的“非 JSON”报错**：直接附上上游实际返回的前 120 字符（网关错误页 / 地区
   拦截页 / baseURL 填错一眼可见）；
4. **修复设置卡片槽位注册**（补 `key: 'image2-draw'`）：新版 Harness 客户端要求
   `options.key`，缺失会导致设置卡片加载失败。

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 20（DSH 官方建议 22.19.x 或 24 LTS，推荐 24）；
- [Git](https://git-scm.com/)（从 GitHub 拉取插件需要）；
- pnpm（`dsh plugin` 内部调用 pnpm；Node 自带 corepack，`corepack enable` 即可）；
- 能访问 `registry.npmjs.org` 与 `github.com`。网络受限时先设置代理（仅当前窗口生效）：

```powershell
$proxy = "http://127.0.0.1:7890"   # 改成你自己的代理端口
$env:HTTP_PROXY = $proxy; $env:HTTPS_PROXY = $proxy
$env:npm_config_proxy = $proxy; $env:npm_config_https_proxy = $proxy
```

## 安装

### 方式 A：全新机器一键安装（最省事）

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.sh | bash
```

脚本自动完成：检查 Node.js（Windows 缺失时用 winget 装 LTS）→ 启用 pnpm →
全局安装 `@deepseek-ai/dsh`（若没有）→ `dsh plugin add` 本插件 → 打印启动指引。

### 方式 B：已装 DSH，一条命令

```bash
dsh plugin --profile web add github:oebeliever/dsh-image2-draw
```

装完**重启 dsh**（重新运行 `dsh web`）即可。包内 `dsh.bundle` 声明会让插件自动挂进
profile bundle 层，无需手动编辑 `cordis.patch.yml`。Web 默认地址 `http://127.0.0.1:3080`。

### 方式 C：不想全局装 dsh？用 npx（首次稍慢，免安装）

```bash
npx --yes -p @deepseek-ai/dsh dsh plugin --profile web add github:oebeliever/dsh-image2-draw
```

之后用同一种方式启动：`npx --yes -p @deepseek-ai/dsh dsh web`。

## 升级与卸载

升级 = 重跑对应安装命令（自动拉取仓库最新提交），然后重启 dsh；无需先卸载。

卸载：

```bash
dsh plugin --profile web remove dsh-image2-draw
```

重启后，“插件配置”中的 **Image2 生图**卡片与生图工具即被移除（已保存的图片文件保留）。

## 使用

1. 打开“设置 > 插件 > 插件配置 > Image2 生图”；
2. 在 `API Key` 输入框填写中转提供的密钥（或改用环境变量 `IMAGE2_API_KEY`）；
3. 在“接口地址”填写中转地址，例如 `https://example.com/v1`；
4. 按需修改模型、图生图端点与超时；通常保持默认即可；
5. 点“保存”并等待“已保存”提示；
6. 新建会话，让模型调用 `image2-generate`（文生图），或提供参考图路径调用 `image2-edit`；
7. **推荐用图形化工作台处理图片输入**：点聊天输入框上方的「🎨 Image2 生图工作台」，
   选择页签（文生图 / 图生图 / 多视角人物），上传图片即可生成，无需写代码或路径。

## 🎨 生图工作台

聊天输入框上方常驻一个可折叠面板（ESC 可收起）：

1. **页签**：文生图 / 图生图 / 多视角人物；
2. **参数行**：尺寸（自适应 / auto / 预置尺寸）、质量（low / medium / high / auto）、
   文生图的张数（1 / 2 / 4，逐张生成）；
3. **素材区**（图生图、多视角人物）：点击选择或**拖拽** PNG/JPEG/WebP 图片
   （单张 ≤4MB、最多 8 张），即时缩略图预览、可移除；上传即存到本机临时区，提交后自动清理；
4. **多视角人物模式**：先上传同一人物 2~8 张不同角度照片（正面 / 侧面 / 全身 / 不同服装等），
   在“动作与场景描述”里写目标画面，点「✨ 按参考图组装一致性提示词」会自动生成
   “保持同一人物五官/身材/发型”的完整提示词，可继续编辑；
5. **生成与结果**：提交后进入后台任务（图片接口通常 30~180 秒），自动轮询；
   完成后结果画廊即时展示，可“另存为”，文件保存在
   `~/.dsh/storages/image2-draw/library/`（dsh 重启后仍可访问）。

> 工作台与对话工具（`image2-generate` / `image2-edit`）共用同一套插件配置
> （API Key / 接口地址 / 模型 / 超时），生成模型与质量均读当前配置。

示例请求：

```text
调用 image2-generate，生成一张竖版的未来城市电影海报，质量设为 high。
```

```text
调用 image2-edit，参考图为 D:\images\room.png，把房间改成日式原木风，保持原有布局。
```

中转服务是否支持 `gpt-image-2`、图生图、自定义尺寸与质量档位，取决于服务商实现。
接口返回 HTTP 400 / 404 时请核对服务商文档中的模型名与 Images 端点格式；
提示 `region-unavailable` 时说明服务商封锁了你当前的出口 IP 地区（常见于中国大陆），
请换海外代理节点并重启 GUI，或更换支持当前地区的中转服务。

## 图片与请求限制

- 文生图每次 1~8 张，插件逐张顺序请求，不并发调用上游；
- 图生图支持 1~8 张参考图，单张 ≤4MB、总计 ≤32MB；
- 参考图只接受 PNG / JPEG / WebP，按文件魔数识别真实格式，不信任扩展名；
- 相对路径以当前会话工作目录为基准；
- 默认超时 180 秒（可配置 1~3600 秒）；远程结果图下载上限 32MB；
- 生成结果只接受 PNG / JPEG / WebP。

## 常见问题 FAQ

| 现象 | 处理 |
|---|---|
| 提示未配置密钥 | 设置页填写 API Key，或设置环境变量 `IMAGE2_API_KEY` 后重启 dsh |
| HTTP 401 / 403 | Key 无效或没有 `gpt-image-2` / images 权限，去中转站核对 |
| HTTP 400 / 404 | 模型名或端点不对：确认 baseURL 是 `.../v1` 且服务商支持 images 接口 |
| 尺寸参数报错 | 网关通常只接受 auto / 1024x1024 / 1536x1024 / 1024x1536 / 3840x2160 等列表内尺寸；请换用预置尺寸或 auto |
| `region-unavailable` | 服务商封锁当前地区（通常是中国大陆 IP）：换海外代理节点并重启 GUI，或换中转 |
| “不是合法 JSON” | 网关错误页/拦截页/地址填错：按报错附带的原文排查 baseURL 与网络 |
| 装了没生效 | 确认是 `web` profile、重启过 dsh；插件面向 Web 界面版 |
| 生成的图片打不开 | 上游可能返回了非图片内容，按提示核对模型与额度；图片同时保存在 outputs/image2/ |

## 开发

```bash
node --check lib/index.js
node --check lib/client.js
```

单元测试（`node tests/plugin.test.mjs`）会引用 `@deepseek-ai/*` 运行时 peer 包，
请在装有这些包的 DSH 环境（profile 的 node_modules 或 Harness 源码工作区）中运行，
而不是在裸检出目录里直接跑。

基于 DeepSeek Harness `0.1.0-rc.6` 公开接口开发（双端插件、设置命名空间、credentials、
工具注册、客户端 slot、WebServer 生命周期）。Harness 仍在 Developer Preview，升级后插件
不加载时，请检查这些接口与 `dsh.client.inject` 声明是否变化。

## 致谢

- 上游作者 [JuneLearn](https://github.com/JuneLearn) 的 [dsh-image2-draw](https://github.com/JuneLearn/dsh-image2-draw)（MIT）；
- 聊天内图片附件与专用工具卡片的部分实现参考并改编自 MIT 协议的
  [dsh-multimodal](https://github.com/MC5lan/dsh-multimodal)，完整第三方声明见
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## License

[MIT](./LICENSE) —— 上游 © 2026 JuneLearn；本分支 © 2026 oebeliever。
