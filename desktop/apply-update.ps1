param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$NoLaunch, [switch]$Launch)
$ErrorActionPreference = 'Stop'
$config = $null
$replaced = $false
$incoming = $null
$backup = $null
function Get-UpdateHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
try {
  $configFile = [IO.Path]::GetFullPath($ConfigPath)
  $stageDir = [IO.Path]::GetDirectoryName($configFile)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($stageDir).TrimEnd('\') -ne $tempRoot -or ![IO.Path]::GetFileName($stageDir).StartsWith('polygate-update-')) { throw 'Invalid update staging folder.' }
  if ($Launch) {
    # Start-Process creates an independent Windows process. DETACHED_PROCESS can make Windows PowerShell exit before loading its script.
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-ConfigPath', ('"' + $configFile + '"'))
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $tempRoot -WindowStyle Hidden
    exit 0
  }
  $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath($config.target)
  $staged = [IO.Path]::GetFullPath($config.staged)
  $targetDir = [IO.Path]::GetDirectoryName($target)
  if ($staged -ne (Join-Path $stageDir 'update.exe') -or !$target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($stageDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid update executable path.' }
  if (!(Test-Path -LiteralPath $target -PathType Leaf) -or $config.expectedHash -notmatch '^[a-f0-9]{64}$') { throw 'The current executable or checksum is missing.' }
  if ((Get-UpdateHash $staged) -ne $config.expectedHash) { throw 'The downloaded update failed its checksum check.' }
  [IO.File]::WriteAllText((Join-Path $stageDir 'ready'), 'ready')
  if ($config.parentPid -gt 0 -and (Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue)) { Wait-Process -Id $config.parentPid -Timeout 45 -ErrorAction Stop }
  $suffix = [guid]::NewGuid().ToString('N')
  $incoming = Join-Path $targetDir ('.polygate-incoming-' + $suffix + '.exe')
  $backup = Join-Path $targetDir ('.polygate-backup-' + $suffix + '.exe')
  # Both resolved paths stay beside the exact portable executable selected by the main process.
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($incoming)) -ne $targetDir -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($backup)) -ne $targetDir) { throw 'Invalid replacement paths.' }
  Copy-Item -LiteralPath $staged -Destination $incoming
  if ((Get-UpdateHash $incoming) -ne $config.expectedHash) { throw 'The copied update failed its checksum check.' }
  # The portable launcher can briefly hold the original file after Electron exits. Never kill another process.
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try { [IO.File]::Replace($incoming, $target, $backup, $true); $replaced = $true; break }
    catch { if ($attempt -eq 59) { throw }; Start-Sleep -Milliseconds 500 }
  }
  [IO.File]::WriteAllText($config.resultPath, (@{ ok=$true; version=$config.version } | ConvertTo-Json -Compress))
  if (!$NoLaunch) { Start-Process -FilePath $target -WorkingDirectory $targetDir }
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  foreach ($file in @($staged, $configFile, (Join-Path $stageDir 'ready'), (Join-Path $stageDir 'launcher-error.log'), $PSCommandPath)) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $stageDir -ErrorAction SilentlyContinue
} catch {
  $message = $_.Exception.Message
  [Console]::Error.WriteLine($message)
  if ($replaced -and $backup -and (Test-Path -LiteralPath $backup)) {
    try { [IO.File]::Replace($backup, $target, $null, $true) } catch { $message += ' The previous executable is saved at ' + $backup }
  }
  if ($incoming -and (Test-Path -LiteralPath $incoming)) { Remove-Item -LiteralPath $incoming -Force -ErrorAction SilentlyContinue }
  if ($config -and $config.resultPath) {
    try { [IO.File]::WriteAllText($config.resultPath, (@{ ok=$false; error=('The update could not finish: ' + $message); version=$config.version } | ConvertTo-Json -Compress)) } catch {}
  }
  if (!$NoLaunch -and $config -and (Test-Path -LiteralPath $config.target)) { Start-Process -FilePath $config.target -WorkingDirectory ([IO.Path]::GetDirectoryName($config.target)) }
  exit 1
}
