$sourceListPath = Join-Path $PSScriptRoot "source_list.txt"
if (-not (Test-Path $sourceListPath)) {
    Write-Host "source_list.txt not found at $sourceListPath"
    exit
}

$content = Get-Content -Path $sourceListPath -Raw
$lines = $content -split "`n"

$output = ""
$processedFiles = @{}

# Search in specific directories to avoid large folders like node_modules
$searchPaths = @("src", "scripts", ".github")

foreach ($line in $lines) {
    $line = $line.Trim()
    if ($line -eq "" -or $line.EndsWith("/")) { continue }

    $filename = $line

    foreach ($searchPath in $searchPaths) {
        if (Test-Path $searchPath) {
            $matchingFiles = Get-ChildItem -Path $searchPath -Recurse -File | Where-Object { $_.Name -eq $filename }

            foreach ($file in $matchingFiles) {
                $fullPath = $file.FullName
                if ($processedFiles.ContainsKey($fullPath)) { continue }

                $processedFiles[$fullPath] = $true

                $output += "$fullPath`n"
                $fileContent = Get-Content -Path $fullPath -Raw
                $output += $fileContent + "`n`n"
            }
        }
    }

    # Also check root level files
    $rootFile = Join-Path "." $filename
    if ((Test-Path $rootFile) -and -not $processedFiles.ContainsKey($rootFile)) {
        $processedFiles[$rootFile] = $true
        $output += "$rootFile`n"
        $fileContent = Get-Content -Path $rootFile -Raw
        $output += $fileContent + "`n`n"
    }
}

$output | Out-File -FilePath "source.tmp" -Encoding UTF8
Write-Host "source.tmp created successfully."
