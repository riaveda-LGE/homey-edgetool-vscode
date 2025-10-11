$sourceListPath = Join-Path $PSScriptRoot "source_list.txt"
if (-not (Test-Path $sourceListPath)) {
    Write-Host "source_list.txt not found at $sourceListPath"
    exit
}

$content = Get-Content -Path $sourceListPath -Raw
$lines = $content -split "`n"

$output = ""
$processedFiles = @{}

foreach ($line in $lines) {
    $line = $line.Trim()
    if ($line -eq "") { continue }

    $filePath = $line

    if (Test-Path $filePath) {
        if ($processedFiles.ContainsKey($filePath)) { continue }

        $processedFiles[$filePath] = $true

        $output += "$filePath`n"
        $fileContent = Get-Content -Path $filePath -Raw
        $output += $fileContent + "`n`n"
    } else {
        Write-Host "File not found: $filePath"
    }
}

$output | Out-File -FilePath "source.tmp" -Encoding UTF8
Write-Host "source.tmp created successfully."
