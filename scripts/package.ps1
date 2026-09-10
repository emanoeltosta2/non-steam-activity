$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'plugin.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $package.version) { throw 'Package and plugin versions differ.' }
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$runtimeFiles = @(
    'plugin.json', '.millennium/Dist/index.js',
    'backend/main.lua', 'backend/rpc_functions.lua', 'launcher/LuaStatusMonitor.exe',
    'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'
)
$sourceFiles = $runtimeFiles + @(
    '.gitignore', '.github/workflows/validate.yml', 'package.json', 'package-lock.json',
    'tsconfig.json', 'frontend/index.tsx', 'launcher/Program.cs',
    'launcher/LuaStatusMonitor.csproj', 'tests/appids.test.cjs', 'scripts/package.ps1'
)
$outputDirectory = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
foreach ($kind in @('windows-x64', 'github-source')) {
    $files = if ($kind -eq 'windows-x64') { $runtimeFiles } else { $sourceFiles }
    $archivePath = Join-Path $outputDirectory "non-steam-activity-$($manifest.version)-$kind.zip"
    # Explicit file list excludes caches, local diagnostics and user data.
    foreach ($relativePath in $files) {
        if (!(Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
            throw "Required file missing: $relativePath"
        }
    }
    $stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relativePath in $files) {
            $source = Join-Path $projectRoot $relativePath
            if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required file missing: $relativePath" }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $source, "non-steam-activity/$relativePath",
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally { $archive.Dispose() }
    $check = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($check.Entries.Count -ne $files.Count) { throw 'Incomplete archive.' }
        if (!$check.GetEntry('non-steam-activity/.millennium/Dist/index.js')) { throw 'Compiled frontend missing.' }
    } finally { $check.Dispose() }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $inputStream = [System.IO.File]::OpenRead($archivePath)
    try {
        $hash = [BitConverter]::ToString($hasher.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant()
    } finally { $inputStream.Dispose(); $hasher.Dispose() }
    "$hash  $([System.IO.Path]::GetFileName($archivePath))" | Set-Content -LiteralPath "$archivePath.sha256" -Encoding ASCII
    Write-Output $archivePath
}
