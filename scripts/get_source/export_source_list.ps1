param($dir)

if (-not $dir) {
    Write-Host "Usage: .\get_list.ps1 <relative_directory_path>"
    exit 1
}

# Get all files recursively
$files = Get-ChildItem -Path $dir -Recurse -File | Select-Object -ExpandProperty FullName

# Convert to relative paths from workspace root
$workspaceRoot = Get-Location
$relativeFiles = $files | ForEach-Object { $_.Replace($workspaceRoot.Path + "\", "") }

# Write to source_list.txt
$relativeFiles | Out-File -FilePath "scripts\get_source\source_list.txt" -Encoding UTF8

Write-Host "File list saved to scripts\get_source\source_list.txt"
