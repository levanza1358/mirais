$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:MIRAIS_REPO_URL) { $env:MIRAIS_REPO_URL } else { 'https://github.com/levanza1358/mirais.git' }
$InstallDir = if ($env:MIRAIS_INSTALL_DIR) { $env:MIRAIS_INSTALL_DIR } else { 'C:\Mirais' }

function Ensure-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host 'Installation in progress... please wait.'
if (-not (Ensure-Command git)) {
  throw 'Git is required. Install Git for Windows first.'
}

if (-not (Ensure-Command bun)) {
  powershell -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex" | Out-Null
  $env:PATH = "$HOME\.bun\bin;$env:PATH"
}

if (Test-Path (Join-Path $InstallDir '.git')) {
  git -C $InstallDir pull --ff-only origin main | Out-Null
} else {
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  git clone $RepoUrl $InstallDir | Out-Null
}

Set-Location $InstallDir

& bun install | Out-Null
Push-Location dashboard
& bun install | Out-Null
Pop-Location

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
}
New-Item -ItemType Directory -Force -Path 'data\backups' | Out-Null

& bun run build | Out-Null

$infoDir = Join-Path ($env:ProgramData ?? 'C:\ProgramData') 'Mirais'
New-Item -ItemType Directory -Force -Path $infoDir | Out-Null
Set-Content -Path (Join-Path $infoDir 'install.json') -Value (@{ root = $InstallDir } | ConvertTo-Json)
$shim = '@echo off`r`nsetlocal`r`ncd /d "' + $InstallDir + '"`r`nbun run scripts/cli.ts %*`r`n'
Set-Content -Path 'C:\Windows\mirais.cmd' -Value $shim

try {
  & bun run scripts/extras.ts | Out-Null
} catch {
  # Optional helpers do not block installation.
}

Write-Host 'Installation successful. Check dashboard at http://localhost:1463'