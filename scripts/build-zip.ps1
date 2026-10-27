# Builds dist\VideoBatchEditor.zip: app + Windows x64 ffmpeg/ffprobe + portable node.exe, ready to unzip and run.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'VideoBatchEditor'
$zip = Join-Path $dist 'VideoBatchEditor.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

foreach ($item in 'lib', 'public', 'server.js', 'package.json', 'start.bat') {
  Copy-Item (Join-Path $root $item) $stage -Recurse
}
Copy-Item (Join-Path $root 'HUONG_DAN.md') (Join-Path $stage 'HUONG_DAN.txt')

# Only the two runtime packages are needed; their other deps are install-time downloaders.
$nm = Join-Path $stage 'node_modules'
Copy-Item (Join-Path $root 'node_modules\ffmpeg-static') (Join-Path $nm 'ffmpeg-static') -Recurse
$probe = Join-Path $nm 'ffprobe-static'
New-Item -ItemType Directory -Force (Join-Path $probe 'bin\win32') | Out-Null
Get-ChildItem (Join-Path $root 'node_modules\ffprobe-static') -File | Copy-Item -Destination $probe
Copy-Item (Join-Path $root 'node_modules\ffprobe-static\bin\win32\x64') (Join-Path $probe 'bin\win32\x64') -Recurse

$nodeExe = (Get-Command node).Source
$nodeDir = Split-Path $nodeExe
New-Item -ItemType Directory -Force (Join-Path $stage 'runtime') | Out-Null
Copy-Item $nodeExe (Join-Path $stage 'runtime\node.exe')
if (Test-Path (Join-Path $nodeDir 'LICENSE')) { Copy-Item (Join-Path $nodeDir 'LICENSE') (Join-Path $stage 'runtime\NODE_LICENSE.txt') }

# Add entries by hand: .NET Framework's CreateFromDirectory writes '\' separators, which non-Windows unzip tools mangle.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in Get-ChildItem $stage -Recurse -File) {
    $entry = 'VideoBatchEditor/' + $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose() }
Remove-Item $stage -Recurse -Force

'{0}  ({1:N0} MB)' -f $zip, ((Get-Item $zip).Length / 1MB)
