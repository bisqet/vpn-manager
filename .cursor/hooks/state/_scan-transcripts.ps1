$ErrorActionPreference = 'Stop'
$root = 'C:\Users\bisqet\.cursor\projects\e-work-VPN-manager\agent-transcripts'
$indexPath = 'E:\work\VPN manager\.cursor\hooks\state\continual-learning-index.json'
$idxObj = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
$idx = @{}
foreach ($p in $idxObj.transcripts.PSObject.Properties) {
  $idx[$p.Name] = $p.Value
}
$files = Get-ChildItem -LiteralPath $root -Recurse -Filter '*.jsonl' | ForEach-Object { $_.FullName }
$toProcess = New-Object System.Collections.Generic.List[object]
foreach ($f in $files) {
  $item = Get-Item -LiteralPath $f
  $iso = $item.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z'
  $old = $idx[$f]
  if ($null -eq $old -or $old -eq '') {
    $toProcess.Add([pscustomobject]@{ path = $f; reason = 'new'; indexed = $null; current = $iso }) | Out-Null
  } else {
    $oldDt = [DateTimeOffset]::Parse($old, $null, [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    $curDt = [DateTimeOffset]::Parse($iso, $null, [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    if ($curDt -gt $oldDt) {
      $toProcess.Add([pscustomobject]@{ path = $f; reason = 'mtime-newer'; indexed = $old; current = $iso }) | Out-Null
    }
  }
}
$missingFromDisk = @()
foreach ($p in $idx.Keys) {
  if (-not (Test-Path -LiteralPath $p)) { $missingFromDisk += $p }
}
Write-Output "TO_PROCESS_COUNT=$($toProcess.Count)"
Write-Output "MISSING_INDEXED=$($missingFromDisk.Count)"
$toProcess | ConvertTo-Json -Depth 4
