<#
.SYNOPSIS
  iroh-agent · 无头命令行聊天室成员 · Windows 一键安装 / 卸载。

.EXAMPLE
  # 安装
  irm https://get.editor.vip/iroh/agent-install.ps1 | iex
  # 卸载（二进制）
  irm https://get.editor.vip/iroh/agent-install.ps1 | iex -Action remove
  # 连身份一起删
  irm https://get.editor.vip/iroh/agent-install.ps1 | iex -Confirm yes -Action remove

.DESCRIPTION
  装完是一个静态二进制，运行时只用系统自带的 ucrt/vcruntime，不需要 Node、
  浏览器或 wasm 运行时。

  身份持久化在 %APPDATA%\iroh-agent\identity.key，所以它在房间里是
  「固定的那个人」。

  产物命名：iroh-agent-windows-<arch>.zip（Windows 用 zip 而不是 tar.gz，
  因为 PowerShell 5.1 自带的 Expand-Archive 只支持 zip）。
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'remove')]
  [string]$Action = 'install',
  # remove 时是否连配置与身份一起删
  [switch]$Confirm,
  # 固定安装目录（默认 %LOCALAPPDATA%\Programs）
  [string]$Prefix = '',
  # 覆盖下载源（默认 GitHub Releases）
  [string]$BaseUrl = '',
  [string]$Repo = 'baisuipingan/iroh-IM',
  [string]$Version = '',
  # 写入 config.json 的字段
  [string]$Relay = 'https://iroh1.editor.vip:15443',
  [string]$Token = '',
  [string]$AnchorId = '',
  [string]$AnchorRelay = '',
  [string]$Nick = '命令行成员'
)

$ErrorActionPreference = 'Stop'
$Bin = 'iroh-agent'

function Ok  { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "  [X]  $m" -ForegroundColor Red; exit 1 }

function Get-TargetArch {
  # Windows: 用 PROCESSOR_ARCHITEW6432 判断（32 位进程跑在 64 位系统上时会设它）
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  switch ("$a".ToUpperInvariant()) {
    'AMD64'  { return 'amd64' }
    'ARM64'  { return 'arm64' }
    'X86'    { return 'x86' }
    'IA64'    { return 'arm64' }
    default   { Die "不支持的架构 $a" }
  }
}

$ConfigDir = if ($env:APPDATA) { Join-Path $env:APPDATA 'iroh-agent' } else { Join-Path $env:USERPROFILE 'AppData\Roaming\iroh-agent' }
if (-not $Prefix) {
  if ($env:LOCALAPPDATA) { $Prefix = Join-Path $env:LOCALAPPDATA 'Programs' }
  else { $Prefix = Join-Path $env:USERPROFILE 'AppData\Local\Programs' }
}
$Exe = Join-Path $Prefix "$Bin.exe"

if ($Action -eq 'remove') {
  if (Test-Path $Exe) { Remove-Item -Force $Exe; Ok "已删除 $Exe" }
  else { Warn "没找到 $Exe" }
  if (Test-Path $ConfigDir) {
    if ($Confirm) { Remove-Item -Recurse -Force $ConfigDir; Ok "已删除配置与身份 $ConfigDir" }
    else { Warn "保留了 $ConfigDir（含身份密钥）。要一起删：-Confirm yes -Action remove" }
  }
  exit 0
}

Ok "平台 windows-$(Get-TargetArch)"
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

if (-not $BaseUrl) {
  if ($Version) { $BaseUrl = "https://github.com/$Repo/releases/download/$Version" }
  else { $BaseUrl = "https://github.com/$Repo/releases/latest/download" }
}
$asset = "$Bin-windows-$(Get-TargetArch).zip"
$url = "$BaseUrl/$asset"
Write-Host "  下载 $url"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("iroh-agent-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp $asset
try {
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -MaximumRedirection 5
  } catch {
    Die "下载失败（还没发布 Release？）：$($_.Exception.Message)`n  可以直接从源码构建：`n    git clone https://github.com/$Repo; cd client-wasm`n    cargo build --release --offline --locked --no-default-features --features cli --bin $Bin"
  }

  # 有 .sha256 就校验（Windows 用 Get-FileHash）
  $sumFile = "$zip.sha256"
  try {
    Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumFile -UseBasicParsing -ErrorAction Stop
    $want = ((Get-Content $sumFile -Raw) -split '\s+')[0].Trim().ToUpperInvariant()
    $have = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
    if ($have -ne $want) { Die "校验和不匹配：期望 $want，实际 $have" }
    Ok "校验和通过"
  } catch {
    Warn "没拿到 .sha256，跳过校验"
  }

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Join-Path $tmp $Bin
  if (-not (Test-Path $src)) { $src = Join-Path $tmp "$Bin.exe" }
  if (-not (Test-Path $src)) { Die "压缩包里没找到 $Bin" }
  Copy-Item -Force $src $Exe
  Ok "已安装 $Exe"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ---- 配置 ----
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$cfg = [ordered]@{
  relays      = @($(if ($AnchorRelay) { $AnchorRelay } else { $Relay }))
  relay_token = $Token
  anchor      = [ordered]@{ id = $AnchorId; relay = $(if ($AnchorRelay) { $AnchorRelay } else { $Relay }) }
  nickname    = $Nick
}
$cfgPath = Join-Path $ConfigDir 'config.json'
$cfg | ConvertTo-Json -Depth 4 | Set-Content -Path $cfgPath -Encoding UTF8
# Windows 上没有 Unix 权限位，改用 ACL 把目录和文件限制到当前用户
try {
  $acl = Get-Acl $ConfigDir
  $acl.SetAccessRuleProtection($true, $false)      # 断继承
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -Path $ConfigDir -AclObject $acl
  Set-Acl -Path $cfgPath -AclObject $acl
  Ok "已把 $ConfigDir 限制为当前用户可访问"
} catch {
  Warn "设置 ACL 失败（不影响使用，但配置与身份将继承默认权限）：$($_.Exception.Message)"
}
Ok "配置已写入 $cfgPath"

if (-not $AnchorId) { Warn "没给 AnchorId —— 不配锚点的话进房可能失败（收不到历史、也难被发现）" }
if (-not $Token)      { Warn "没给 Token —— 中继开了鉴权的话会连不上" }

$env:PATH = "$Prefix;$env:PATH"
Write-Host ""
Ok "完成。试试："
Write-Host "     $Bin whoami"
Write-Host "     $Bin say   --room 我的项目 '构建完成'"
Write-Host "     $Bin send  --room 我的项目 --file C:\path\pkg.tar.gz"
Write-Host "     $Bin watch --room 我的项目"
Write-Host ""
Warn "若提示找不到命令，把 $Prefix 加进 PATH。"