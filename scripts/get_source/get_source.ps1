# scripts/get_source/get_source.ps1
param(
    # 목록 파일 경로(없으면 프로젝트 루트의 source_list.txt 사용)
    [string]$ListPath = (Join-Path $PSScriptRoot "source_list.txt"),
    # 출력 파일 경로
    [string]$OutPath  = (Join-Path $PSScriptRoot "source.tmp"),
    # 프로젝트 루트 (scripts\get_source\.. \..)
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = 'Stop'

# 목록 파일 찾기 (스크립트 폴더 → 프로젝트 루트)
if (-not (Test-Path -LiteralPath $ListPath)) {
    $alt = Join-Path $ProjectRoot "source_list.txt"
    if (Test-Path -LiteralPath $alt) { $ListPath = $alt }
    else {
        Write-Host "source_list.txt not found at $ListPath or $alt"
        exit 1
    }
}

# 목록을 UTF-8로 읽고(# 주석/빈줄 무시)
$lines = Get-Content -Path $ListPath -Encoding UTF8 |
         ForEach-Object { $_.Trim() } |
         Where-Object { $_ -and -not $_.StartsWith('#') }

$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$sb   = [System.Text.StringBuilder]::new()

foreach ($relPath in $lines) {
    # ✅ 상대경로는 '프로젝트 루트' 기준
    $filePath = if ([IO.Path]::IsPathRooted($relPath)) { $relPath }
                else { Join-Path $ProjectRoot $relPath }

    if (-not (Test-Path -LiteralPath $filePath)) {
        Write-Host "File not found: $filePath"
        continue
    }

    $full = (Get-Item -LiteralPath $filePath).FullName
    if (-not $seen.Add($full)) { continue }

    # 제목 줄에 목록 그대로 남김(루트 기준 상대경로)
    [void]$sb.AppendLine($relPath)

    # 파일을 UTF-8로 강제 읽기(한글 깨짐 방지)
    $text = Get-Content -LiteralPath $filePath -Raw -Encoding UTF8
    [void]$sb.AppendLine($text)
    [void]$sb.AppendLine()
}

# UTF-8 with BOM으로 저장(메모장 등에서도 한글 안전)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($OutPath, $sb.ToString(), $utf8Bom)

Write-Host "ProjectRoot = $ProjectRoot"
Write-Host "source.tmp created successfully. -> $OutPath"
