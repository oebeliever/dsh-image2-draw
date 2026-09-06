#!/usr/bin/env bash
# dsh-image2-draw —— DeepSeek Harness Image2（gpt-image-2）生图插件「一键安装脚本」(macOS / Linux)
#
# 用法（复制下面一行到终端回车即可）：
#   curl -fsSL https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.sh | bash
#
# 脚本会依次：检查 Node.js → 启用 pnpm → 缺少 dsh 时全局安装 @deepseek-ai/dsh →
# 把插件装入 web profile → 打印启动与配置指引。
set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
REPO='github:oebeliever/dsh-image2-draw'

say() { printf '\n==> %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

say '检查 Node.js'
if ! command -v node >/dev/null 2>&1; then
  die '未检测到 Node.js。请先安装 Node.js LTS（https://nodejs.org，或 nvm install --lts）后重跑本脚本。'
fi
node --version

say '检查 pnpm（dsh plugin 依赖 pnpm）'
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  die 'pnpm 不可用，请执行 npm install -g pnpm 或参考 https://pnpm.io/installation 后重跑本脚本。'
fi
pnpm --version

say '检查 dsh CLI'
if ! command -v dsh >/dev/null 2>&1; then
  say '未检测到 dsh，正在全局安装 @deepseek-ai/dsh（首次下载较慢）…'
  npm install -g @deepseek-ai/dsh
fi
if ! command -v dsh >/dev/null 2>&1; then
  die 'dsh 安装失败，请手动执行 npm install -g @deepseek-ai/dsh 后重试。'
fi

say "把 dsh-image2-draw 安装进 profile「${PROFILE}」"
dsh plugin --profile "$PROFILE" add "$REPO"

cat <<EOF

✔ 安装完成！

接下来 4 步即可出图：
  1. 启动 DSH Web：    dsh web          （默认打开 http://127.0.0.1:3080）
  2. 打开 设置 → 插件 → 插件配置 → 「Image2 生图」
  3. 填入任意 OpenAI Images 兼容中转的：API Key + 接口地址 baseURL
     （如 https://example.com/v1，自动补全 /images/generations；需支持 gpt-image-2）
  4. 新建会话，让 AI 调用 image2-generate（文生图）/ image2-edit（图生图）

升级：重跑本脚本（或 dsh plugin --profile ${PROFILE} add ${REPO}）后重启 dsh
卸载：dsh plugin --profile ${PROFILE} remove dsh-image2-draw
EOF
