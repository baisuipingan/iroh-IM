<#
.SYNOPSIS
  iroh-agent · Skill 自带的安装脚本（Windows）。

.DESCRIPTION
  自包含：随 Skill 目录一起复制到任何 Windows 机器。
  与 deploy/install/agent-install.ps1 是同一套产物命名约定的两份实现：
  那份给人和运维（功能更全），这份随 Skill 分发。改一处记得同步另一处，
  以及 .github/workflows/release-agent.yml 的矩阵。

  Windows 产物打包成 .zip 而不是 .tar.gz —— PowerShell 5.1 自带的
  Expand-Archive 只支持 zip。
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'remove')][string]$Action = 'install',
  [switch]$Confirm,
  [string]$Prefix = '',
  [string]$BaseUrl = '',
  [string]$Repo = 'baisuipingan/iroh-IM',
  [string]$Version = '',
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

# 32 位进程跑在 64 位系统上时，PROCESSOR_ARCHITEW6432 才有值
$archEnv = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ("$archEnv".ToUpperInvariant()) {
  'AMD64' { $Arch = 'amd64' }
  'ARM64' { $Arch = 'arm64' }
  'IA64'  { $Arch = 'arm64' }
  'X86'   { Die "不支持 32 位 Windows" }
  default  { Die "不支持的架构 $archEnv" }
}

if ($env:APPDATA) { $ConfigDir = Join-Path $env:APPDATA 'iroh-agent' }
else { $ConfigDir = Join-Path $env:USERPROFILE 'AppData\Roaming\iroh-agent' }
if (-not $Prefix) {
  if ($env:LOCALAPPDATA) { $Prefix = Join-Path $env:LOCALAPPDATA 'Programs' }
  else { $Prefix = Join-Path $env:USERPROFILE 'AppData\Local\Programs' }
}
$Exe = Join-Path $Prefix "$Bin.exe"

if ($Action -eq 'remove') {
  if (Test-Path $Exe) { Remove-Item -Force $Exe; Ok "已删除 $Exe" } else { Warn "没找到 $Exe" }
  if (Test-Path $ConfigDir) {
    if ($Confirm) { Remove-Item -Recurse -Force $ConfigDir; Ok "已删除配置与身份 $ConfigDir" }
    else { Warn "保留了 $ConfigDir（含身份密钥）。要一起删：-Confirm -Action remove" }
  }
  exit 0
}

Ok "平台 windows-$Arch"
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

if (-not $BaseUrl) {
  if ($Version) { $BaseUrl = "https://github.com/$Repo/releases/download/$Version" }
  else {
    # ⚠️ "latest" 按**本产物族的 tag 前缀**解析，不能用 GitHub 的 releases/latest：
    # 两条产物线（agent-v* / android-v*）共用一个全局 Latest，谁最后发布谁就是它，
    # 另一条线立刻 404（2026-10-10 真踩到）。
    $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=30"
    $tag = ($rel | Where-Object { $_.tag_name -like 'agent-v*' } | Select-Object -First 1).tag_name
    if (-not $tag) { Die "没能从 GitHub 解析出 agent 的 Release（网络？）—— 也可以显式指定：-Version agent-v1.2.0" }
    Ok "latest → $tag"
    $BaseUrl = "https://github.com/$Repo/releases/download/$tag"
  }
}
$asset = "$Bin-windows-$Arch.zip"
$url = "$BaseUrl/$asset"
Write-Host "  下载 $url"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("iroh-agent-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  try { Invoke-WebRequest -Uri $url -OutFile "$tmp\$asset" -UseBasicParsing -MaximumRedirection 5 }
  catch {
    Die "下载失败（Release 里还没有这个平台的产物？）`n  可以从源码构建（需要 Rust）：`n    git clone https://github.com/$Repo; cd client-wasm`n    cargo build --release --locked --no-default-features --features cli --bin agent`n    （cargo 里的 bin 名字是 agent，装成 iroh-agent 要改名）"
  }
  try {
    Invoke-WebRequest -Uri "$url.sha256" -OutFile "$tmp\sum" -UseBasicParsing -ErrorAction Stop
    $want = ((Get-Content "$tmp\sum" -Raw) -split '\s+')[0].Trim().ToUpperInvariant()
    $have = (Get-FileHash -Path "$tmp\$asset" -Algorithm SHA256).Hash
    if ($have -ne $want) { Die "校验和不匹配：期望 $want 实际 $have" }
    Ok "校验和通过"
  } catch { Warn "没拿到 .sha256，跳过校验" }

  Expand-Archive -Path "$tmp\$asset" -DestinationPath $tmp -Force
  $src = Join-Path $tmp $Bin
  if (-not (Test-Path $src)) { $src = Join-Path $tmp "$Bin.exe" }
  if (-not (Test-Path $src)) { Die "压缩包里没找到 $Bin" }
  Copy-Item -Force $src $Exe
  Ok "已安装 $Exe"
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$useRelay = if ($AnchorRelay) { $AnchorRelay } else { $Relay }
$cfg = [ordered]@{
  relays      = @($useRelay)
  relay_token = $Token
  anchor      = [ordered]@{ id = $AnchorId; relay = $useRelay }
  nickname    = $Nick
}
$cfgPath = Join-Path $ConfigDir 'config.json'
$cfg | ConvertTo-Json -Depth 4 | Set-Content -Path $cfgPath -Encoding UTF8
# Windows 没有 Unix 权限位，用 ACL 把目录和文件限制到当前用户
try {
  $acl = Get-Acl $ConfigDir
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule); Set-Acl -Path $ConfigDir -AclObject $acl; Set-Acl -Path $cfgPath -AclObject $acl
  Ok "已把 $ConfigDir 限制为当前用户可访问"
} catch { Warn "设置 ACL 失败（不影响使用）：$($_.Exception.Message)" }
Ok "配置已写入 $cfgPath"

if (-not $AnchorId) { Warn "没给 AnchorId —— 不配锚点的话进房可能失败（收不到历史、也难被发现）" }
if (-not $Token)     { Warn "没给 Token —— 中继开了鉴权的话会连不上" }

$env:PATH = "$Prefix;$env:PATH"
Write-Host ""
Ok "完成。验证一下（这一步会真的连中继）："
Write-Host "     $Bin whoami"
Write-Host "     $Bin say   --room 我的项目 '构建完成'"
Write-Host "     $Bin send  --room 我的项目 --file C:\path\pkg.tar.gz"
Write-Host "     $Bin watch --room 我的项目"
Write-Host ""
Warn "若提示找不到命令，把 $Prefix 加进 PATH。"
