#!/usr/bin/env pwsh
#Requires -Version 5.1
<#
  dsh-image2-draw —— DeepSeek Harness Image2（gpt-image-2）生图插件「一键安装脚本」（Windows）

  用法（复制下面任意一行到 PowerShell 回车即可，无需先装任何东西）：
    推荐（保持本机干净）：
      irm https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.ps1 | iex

  脚本会依次：检查/安装 Node.js（缺失时用 winget 装 LTS）→ 启用 pnpm →
  缺少 dsh 时全局安装 @deepseek-ai/dsh → 把插件装入 web profile →
  打印启动与配置指引。
#>
[CmdletBinding()]
param(
  [string]$DshProfile = 'web'
)

$ErrorActionPreference = 'Stop'
$Repo = 'github:oebeliever/dsh-image2-draw'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }

Step '检查 Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Step '未检测到 Node.js，正在用 winget 安装 Node.js LTS（约 1 分钟）…'
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent | Out-Host
    # 刷新 PATH（新装的 Node 一般需要重开终端才生效，这里主动补上）
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'Node.js 不可用。请先到 https://nodejs.org 安装 Node.js LTS，再重跑本脚本。' }
}
Write-Host ("    Node.js {0}" -f (& node --version))

Step '检查 pnpm（dsh plugin 依赖 pnpm）'
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  Step '未检测到 pnpm，正在通过 corepack 启用…'
  & corepack enable 2>$null
  & corepack prepare pnpm@latest --activate 2>$null | Out-Null
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
}
if (-not $pnpm) { Fail 'pnpm 仍不可用，请按 https://pnpm.io/installation 安装后重试。' }
Write-Host ("    pnpm {0}" -f (& pnpm --version))

Step '检查 dsh CLI'
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  Step '未检测到 dsh，正在全局安装 @deepseek-ai/dsh（首次下载较慢，请耐心等待）…'
  & npm install -g @deepseek-ai/dsh
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
}
if (-not $dsh) { Fail 'dsh 安装失败，请手动执行 npm install -g @deepseek-ai/dsh 后重试。' }

Step "把 dsh-image2-draw 安装进 profile「$DshProfile」"
& dsh plugin --profile $DshProfile add $Repo
if ($LASTEXITCODE -ne 0) {
  Fail "插件安装失败（退出码 $LASTEXITCODE）。若提示 allowBuilds 相关错误，请把 pnpm 打印的 key 加入 ~/.dsh/profiles/$DshProfile/pnpm-workspace.yaml 的 allowBuilds 后重跑。"
}

Write-Host "`n✔ 安装完成！" -ForegroundColor Green
Write-Host @"

接下来 4 步即可出图：
  1. 启动 DSH Web：    dsh web          （默认打开 http://127.0.0.1:3080）
  2. 打开 设置 → 插件 → 插件配置 → 「Image2 生图」
  3. 填入任意 OpenAI Images 兼容中转的：API Key + 接口地址 baseURL
     （如 https://example.com/v1，自动补全 /images/generations；需支持 gpt-image-2）
  4. 新建会话，让 AI 调用 image2-generate（文生图）/ image2-edit（图生图）

升级：重跑本脚本（或 dsh plugin --profile $DshProfile add $Repo）后重启 dsh
卸载：dsh plugin --profile $DshProfile remove dsh-image2-draw
"@
