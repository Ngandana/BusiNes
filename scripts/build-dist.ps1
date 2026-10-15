# Packs ONLY the public app files into .\dist so you can drag that folder onto Netlify Drop
# (or any static host). Never upload the project folder itself: it holds .env.local with secrets.
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory $dist | Out-Null
foreach ($f in "index.html","styles.css","app.js","config.js","sw.js","manifest.webmanifest","_headers") { Copy-Item (Join-Path $root $f) $dist }
Copy-Item (Join-Path $root "icons") (Join-Path $dist "icons") -Recurse
New-Item -ItemType Directory (Join-Path $dist "vendor") | Out-Null
Copy-Item (Join-Path $root "vendor\supabase.js") (Join-Path $dist "vendor")

# Safety check: refuse to continue if any file carries a service_role key or a new-style secret key.
foreach ($file in Get-ChildItem $dist -Recurse -File) {
  $text = Get-Content $file.FullName -Raw
  if ($text -match "sb_secret_") { Write-Error "Secret key found in $($file.Name). Stopping."; exit 1 }
  foreach ($m in [regex]::Matches($text, "eyJ[\w-]+\.([\w-]+)\.[\w-]+")) {
    $p = $m.Groups[1].Value.Replace("-","+").Replace("_","/")
    $p = $p.PadRight($p.Length + (4 - $p.Length % 4) % 4, "=")
    try { $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) } catch { continue }
    if ($json -match '"role"\s*:\s*"service_role"') { Write-Error "A service_role key is in $($file.Name). Stopping."; exit 1 }
  }
}
Write-Host "Done. Upload this folder: $dist"
