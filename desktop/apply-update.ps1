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
# The old app quits as soon as the helper reports it is ready, so it can be gone before, or while, this waits. A process that is already
# gone counts as closed; only one that is still running after the wait is a failure.
function Wait-ForOldApp([int]$ProcessId, [int]$TimeoutSeconds) {
  if ($ProcessId -le 0) { return }
  Wait-Process -Id $ProcessId -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
  if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) { throw 'The old app did not close in time.' }
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
  # The config is UTF-8; Windows PowerShell 5.1 would read it as ANSI and garble a user name with non-English letters.
  $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath($config.target)
  $staged = [IO.Path]::GetFullPath($config.staged)
  $targetDir = [IO.Path]::GetDirectoryName($target)
  if ($staged -ne (Join-Path $stageDir 'update.exe') -or !$target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($stageDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid update executable path.' }
  if (!(Test-Path -LiteralPath $target -PathType Leaf) -or $config.expectedHash -notmatch '^[a-f0-9]{64}$') { throw 'The current executable or checksum is missing.' }
  if ((Get-UpdateHash $staged) -ne $config.expectedHash) { throw 'The downloaded update failed its checksum check.' }
  [IO.File]::WriteAllText((Join-Path $stageDir 'ready'), 'ready')
  Wait-ForOldApp $config.parentPid 45
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
  # A portable build is named after its version (Polygate-0.5.1-Windows-x64.exe). After an update the file carries the new version, so its name does not
  # claim an old one. Any other name is left alone, and so is a file that already has the new name; a failed rename keeps the old name.
  $final = $target
  $named = [regex]::Match([IO.Path]::GetFileName($target), '^(Polygate-)\d+\.\d+\.\d+(-Windows-x64\.exe)$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($named.Success -and $config.version -match '^\d+\.\d+\.\d+$') {
    $renamed = Join-Path $targetDir ($named.Groups[1].Value + $config.version + $named.Groups[2].Value)
    if ($renamed -ne $target -and !(Test-Path -LiteralPath $renamed)) { try { Move-Item -LiteralPath $target -Destination $renamed; $final = $renamed } catch { $final = $target } }
  }
  [IO.File]::WriteAllText($config.resultPath, (@{ ok=$true; version=$config.version; path=$final } | ConvertTo-Json -Compress))
  # The update is already in place; a launch that fails must not roll it back.
  if (!$NoLaunch) { try { Start-Process -FilePath $final -WorkingDirectory $targetDir } catch { [Console]::Error.WriteLine('The update was installed but the app could not be started: ' + $_.Exception.Message) } }
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
