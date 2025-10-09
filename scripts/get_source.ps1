if (Test-Path "source.tmp") {
    Remove-Item "source.tmp"
}

$folders = @("src", "media")
$output = ""

foreach ($folder in $folders) {
    if (Test-Path $folder) {
        $files = Get-ChildItem -Path $folder -Recurse -File
        foreach ($file in $files) {
            $output += "=== $($file.FullName) ===`n"
            $content = Get-Content -Path $file.FullName -Raw
            $output += $content + "`n`n"
        }
    }
}

# Add package.json
if (Test-Path "package.json") {
    $output += "=== package.json ===`n"
    $content = Get-Content -Path "package.json" -Raw
    $output += $content + "`n`n"
}

$output | Out-File -FilePath "source.tmp" -Encoding UTF8
