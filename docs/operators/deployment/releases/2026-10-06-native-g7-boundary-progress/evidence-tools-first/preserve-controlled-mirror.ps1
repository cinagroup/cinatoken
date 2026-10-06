$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
$toolDirectory = $PSScriptRoot
$mirrorDirectory = Join-Path $toolDirectory 'collector-must-not-write-repo'
$zipPath = Join-Path $toolDirectory 'initial-controlled-mirror.zip'
$indexPath = Join-Path $toolDirectory 'initial-controlled-mirror.index.json'
$zipStream = $null
$zipArchive = $null
function Get-ByteDescriptor([byte[]] $data) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($algorithm.ComputeHash($data))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
    return @{ bytes = $data.Length; sha256 = $hash }
}
if (!(Test-Path -LiteralPath $mirrorDirectory -PathType Container)) { throw 'Expected controlled mirror absent' }
$allItems = @(Get-ChildItem -LiteralPath $mirrorDirectory -Recurse -Force)
foreach ($item in $allItems) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked controlled mirror rejected' }
}
$sourceFiles = @($allItems | Where-Object { !$_.PSIsContainer } | Sort-Object FullName)
$entries = @()
try {
    $zipStream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $zipArchive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($file in $sourceFiles) {
        $relative = [IO.Path]::GetRelativePath($mirrorDirectory, $file.FullName).Replace('\', '/')
        if ($relative.StartsWith('../') -or [IO.Path]::IsPathRooted($relative)) { throw 'Controlled mirror path escape' }
        $bytes = [IO.File]::ReadAllBytes($file.FullName)
        $entry = $zipArchive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        try { $entryStream.Write($bytes, 0, $bytes.Length) } finally { $entryStream.Dispose() }
        $descriptor = Get-ByteDescriptor $bytes
        $entries += [ordered]@{ sourceRelative = "collector-must-not-write-repo/$relative"; member = $relative; bytes = $descriptor.bytes; sha256 = $descriptor.sha256 }
    }
} finally {
    if ($null -ne $zipArchive) { $zipArchive.Dispose() }
    if ($null -ne $zipStream) { $zipStream.Dispose() }
}
$reader = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    if ($reader.Entries.Count -ne $entries.Count) { throw 'ZIP entry count mismatch' }
    foreach ($item in $entries) {
        $entry = $reader.GetEntry($item.member)
        if ($null -eq $entry) { throw 'ZIP member missing' }
        $entryStream = $entry.Open()
        $buffer = [IO.MemoryStream]::new()
        try { $entryStream.CopyTo($buffer); $roundtrip = $buffer.ToArray() }
        finally { $entryStream.Dispose(); $buffer.Dispose() }
        $source = [IO.File]::ReadAllBytes((Join-Path $toolDirectory $item.sourceRelative))
        $roundtripDescriptor = Get-ByteDescriptor $roundtrip
        $sourceDescriptor = Get-ByteDescriptor $source
        if ($roundtripDescriptor.bytes -ne $item.bytes -or $roundtripDescriptor.sha256 -ne $item.sha256 -or
            $sourceDescriptor.bytes -ne $item.bytes -or $sourceDescriptor.sha256 -ne $item.sha256) { throw 'ZIP byte/hash roundtrip failed' }
        $item['roundtripExact'] = $true
    }
} finally { $reader.Dispose() }
$zipDescriptor = Get-ByteDescriptor ([IO.File]::ReadAllBytes($zipPath))
$report = [ordered]@{
    closed = $true; actualArchiveOutcome = 0; materialKind = 'lossless-synthetic-controlled-test-mirror';
    reason = 'Initial immutable old suite was invoked from Temp instead of repo, so its repository-output negative check wrote a synthetic controlled fixture mirror then failed actual1. No source repository write occurred. Original command raw/receipt and test source remain separately retained. The exact mirror remains untouched and is preserved losslessly here.';
    sourceDirectory = $mirrorDirectory; sourceModified = $false; archive = 'initial-controlled-mirror.zip';
    archiveBytes = $zipDescriptor.bytes; archiveSha256 = $zipDescriptor.sha256; memberCount = $entries.Count;
    entries = $entries;
    explicitDuplicateFileExclusions = @($entries | ForEach-Object { [ordered]@{ file = $_.sourceRelative; reason = 'Duplicate stored synthetic controlled-test mirror bytes preserved losslessly in initial-controlled-mirror.zip and exact per-member index. Original failure receipt/raw/source remain included.' } });
    serviceOrCiExecution = $false; productionRequests = 0
}
$json = $report | ConvertTo-Json -Depth 12
$output = [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
$indexStream = [IO.File]::Open($indexPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $indexStream.Write($output, 0, $output.Length) } finally { $indexStream.Dispose() }
$indexDescriptor = Get-ByteDescriptor $output
[ordered]@{ actualArchiveOutcome = 0; memberCount = $entries.Count; indexPath = $indexPath; bytes = $indexDescriptor.bytes; sha256 = $indexDescriptor.sha256 } | ConvertTo-Json -Compress
