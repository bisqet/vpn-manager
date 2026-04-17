$indexPath = 'E:\work\VPN manager\.cursor\hooks\state\continual-learning-index.json'
$idx = Get-Content -Raw $indexPath | ConvertFrom-Json
$t = $idx.transcripts
Write-Output ("Type=" + $t.GetType().FullName)
$map = @{}
if ($t -is [hashtable]) {
  foreach ($k in $t.Keys) { $map[$k] = $t[$k] }
} else {
  foreach ($prop in $t.PSObject.Properties) { $map[$prop.Name] = $prop.Value }
}
Write-Output ("MapCount=" + $map.Count)
$sample = 'C:\Users\bisqet\.cursor\projects\e-work-VPN-manager\agent-transcripts\3029fdd2-2358-4911-a754-8c37b5d87b1f\3029fdd2-2358-4911-a754-8c37b5d87b1f.jsonl'
Write-Output ("HasSample=" + $map.ContainsKey($sample))
if ($map.ContainsKey($sample)) { Write-Output ("Val=" + $map[$sample]) }
$p = Get-Item $sample
Write-Output ("Mtime=" + $p.LastWriteTimeUtc.ToString('o'))
