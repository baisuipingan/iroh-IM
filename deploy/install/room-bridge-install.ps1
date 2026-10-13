<#
.SYNOPSIS
  room-bridge · Windows 一键安装 / 卸载（单文件适配器，见 docs/bring-your-own-agent.md）。

.EXAMPLE
  # 安装
  irm https://get.editor.vip/iroh/room-bridge-install.ps1 | iex
  # 卸载（只删二进制）
  irm https://get.editor.vip/iroh/room-bridge-install.ps1 | iex -Action remove

.DESCRIPTION
  装完是一个**单文件可执行**（bun --compile）：不需要 Node、不需要 clone 仓库。
  rule / command / acp 三条大脑可用；pi-sdk 需要 Node 版（npm/仓库），
  单文件里会给一句人话提示。

  ⚠️ 它只是"手"，还需要 `iroh-agent` 这个"腿"（协议在那边）：
     irm https://get.editor.vip/iroh/agent-install.ps1 | iex
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'remove')]
  [string]$Action = 'install',
  [string]$Prefix = '',
  [string]$BaseUrl = '',
  [string]$Repo = 'baisuipingan/iroh-IM',
  [string]$Version = '',
  # 只装适配器，不检查/安装 iroh-agent（也可用环境变量 SKIP_AGENT=1）
  [switch]$SkipAgent
)

$ErrorActionPreference = 'Stop'
$Bin = 'room-bridge'

function Ok  { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "  [X]  $m" -ForegroundColor Red; exit 1 }

function Get-TargetArch {
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  switch ("$a".ToUpperInvariant()) {
    'AMD64'  { return 'amd64' }
    'ARM64'  { return 'arm64' }
    default  { Die "不支持的架构 $a" }
  }
}

if (-not $Prefix) {
  if ($env:LOCALAPPDATA) { $Prefix = Join-Path $env:LOCALAPPDATA 'Programs' }
  else { $Prefix = Join-Path $env:USERPROFILE 'AppData\Local\Programs' }
}
$Exe = Join-Path $Prefix "$Bin.exe"

if ($Action -eq 'remove') {
  if (Test-Path $Exe) { Remove-Item -Force $Exe; Ok "已删除 $Exe" }
  else { Warn "没找到 $Exe" }
  exit 0
}

Ok "平台 windows-$(Get-TargetArch)"
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

if (-not $BaseUrl) {
  if ($Version) { $BaseUrl = "https://github.com/$Repo/releases/download/$Version" }
  else {
    # ⚠️ "latest" 按**本产物族的 tag 前缀**解析（agent-v* / android-v* / bridge-v* 多条线）
    $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=30"
    $tag = ($rel | Where-Object { $_.tag_name -like 'bridge-v*' } | Select-Object -First 1).tag_name
    if (-not $tag) { Die "没能解析出 bridge 的 Release（网络？）—— 可显式指定：-Version bridge-v0.1.0" }
    Ok "latest → $tag"
    $BaseUrl = "https://github.com/$Repo/releases/download/$tag"
  }
}
$asset = "$Bin-windows-$(Get-TargetArch).exe"
$url = "$BaseUrl/$asset"
Write-Host "  下载 $url"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("room-bridge-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$dst = Join-Path $tmp $asset
try {
  try {
    Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing -MaximumRedirection 5
  } catch {
    Die "下载失败（还没发布 Release？）：$($_.Exception.Message)`n  也可以自己编：bash scripts/build-room-bridge.sh"
  }

  $sumUrl = "$url.sha256"
  try {
    $sumFile = Join-Path $tmp "$asset.sha256"
    Invoke-WebRequest -Uri $sumUrl -OutFile $sumFile -UseBasicParsing -ErrorAction Stop
    $want = ((Get-Content $sumFile -Raw) -split '\s+')[0].Trim().ToUpperInvariant()
    $have = (Get-FileHash -Path $dst -Algorithm SHA256).Hash
    if ($have -ne $want) { Die "校验和不匹配：期望 $want，实际 $have" }
    Ok "校验和通过"
  } catch {
    Die "拿不到 .sha256 —— 供应链校验失败，拒绝安装"
  }

  Copy-Item -Force $dst $Exe
  Ok "已安装 $Exe"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($SkipAgent -or $env:SKIP_AGENT -eq '1') {
  Warn "跳过 iroh-agent 的检查与安装（-SkipAgent / SKIP_AGENT=1）"
} elseif ((Get-Command iroh-agent -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $Prefix 'iroh-agent.exe'))) {
  Ok "iroh-agent 已在（腿有了）"
} else {
  Warn "没装 iroh-agent（room-bridge 只是适配器，协议在它那里）——顺带装上："
  $agentUrl = if ($env:AGENT_SCRIPT_URL) { $env:AGENT_SCRIPT_URL } else { 'https://get.editor.vip/iroh/agent-install.ps1' }
  $agentPs1 = Join-Path $tmp 'agent-install.ps1'
  try {
    Invoke-WebRequest -Uri $agentUrl -OutFile $agentPs1 -UseBasicParsing -MaximumRedirection 5
    # ⚠️ 用**子进程**跑：agent 安装脚本里有 `exit`（成功/失败都会退进程），
    #    同进程调用会把我们自己也带退掉。
    $psExe = if (Get-Command powershell.exe -ErrorAction SilentlyContinue) { 'powershell.exe' } else { 'pwsh' }
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $agentPs1 -Prefix $Prefix
    if ($LASTEXITCODE -ne 0) { throw "agent 安装脚本退出码 $LASTEXITCODE" }
    Ok "iroh-agent 已装到 $Prefix"
  } catch {
    Die "iroh-agent 自动安装失败（网络？）——手动补：irm https://get.editor.vip/iroh/agent-install.ps1 | iex"
  }
}

$env:PATH = "$Prefix;$env:PATH"
Write-Host ""
Ok "完成。试试："
Write-Host "     $Bin --room 我的房间 --nick 小派 --bio '会查代码' --tags ts,rust --brain acp --acp-bin claude-code-acp"
Write-Host "     $Bin --help"
Write-Host ""
Warn "若提示找不到命令，把 $Prefix 加进 PATH。"
Warn "需要 Node 的 pi-sdk 大脑不在这份单文件里（npm/仓库版支持）。"
