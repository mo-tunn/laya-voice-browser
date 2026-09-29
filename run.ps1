$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$NodeProcess = $null

function Stop-VoiceBrowserTree {
  param([System.Diagnostics.Process]$Process)

  if ($Process -and -not $Process.HasExited) {
    Write-Host "Stopping voice-browser and child processes..."
    # Ctrl+C is delivered to Node too, so give server.js a short chance to close Playwright
    # and Laya cleanly before using the hard Windows process-tree fallback.
    $Process.WaitForExit(3000) | Out-Null
    if (-not $Process.HasExited) {
      # /T kills the full Windows process tree (Node -> Laya Python + Playwright Chromium).
      & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    }
  }

  # Defensive cleanup for a Laya process that somehow outlived Node. Restrict this to the
  # exact project script so we never kill unrelated Python processes on the machine.
  $projectScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "scripts\laya-browser-server.py"))
  Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and $_.CommandLine.IndexOf($projectScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } |
    ForEach-Object {
      & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
    }
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Laya virtual environment is missing; installing it first..."
  & "$PSScriptRoot\scripts\setup-laya.ps1"
}

# If the caller did not choose a port, prefer 8787 but fall back to the next free local port.
$hasPortArg = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq "--port") { $hasPortArg = $true; break }
}

if (-not $hasPortArg) {
  $port = 8787
  while (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    $port++
  }
  if ($port -ne 8787) {
    Write-Host "Port 8787 is already in use; using port $port instead."
  }
  Write-Host "Control room: http://localhost:$port"
  $nodeArgs = @("src/start.js", "--port", "$port") + $args
} else {
  $nodeArgs = @("src/start.js") + $args
}

try {
  # Keep the child in this console so Ctrl+C is delivered to Node as SIGINT. The finally
  # block below is the hard guarantee that no Laya/Chromium child survives the launcher.
  $NodeProcess = Start-Process -FilePath "node.exe" -ArgumentList $nodeArgs -NoNewWindow -PassThru
  Wait-Process -Id $NodeProcess.Id
  if ($NodeProcess.ExitCode -and $NodeProcess.ExitCode -ne 0) {
    exit $NodeProcess.ExitCode
  }
} finally {
  Stop-VoiceBrowserTree -Process $NodeProcess
}
