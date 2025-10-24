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
$rawLines = Get-Content -Path $ListPath -Encoding UTF8 |
           ForEach-Object { $_.Trim() } |
           Where-Object { $_ -and -not $_.StartsWith('#') }

# git status 형식 파싱: "status:   path" → path 추출
$lines = $rawLines | ForEach-Object {
    if ($_ -match '^(modified|new file|deleted|renamed):\s+(.+)$') {
        $matches[2]
    } else {
        $_
    }
}

# 중복 제거
$uniqueLines = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($line in $lines) {
    [void]$uniqueLines.Add($line)
}
$lines = $uniqueLines

$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$maxLinesPerFile = 5000

# Phase 1: 총 라인 수 계산 및 총 파일 개수 결정
$totalLines = 0
foreach ($relPath in $lines) {
    $filePath = if ([IO.Path]::IsPathRooted($relPath)) { $relPath }
                else { Join-Path $ProjectRoot $relPath }

    if ($relPath -like '*[*]*') {
        try {
            $matchedFiles = Get-ChildItem -Path $filePath -File -ErrorAction Stop
            foreach ($file in $matchedFiles) {
                $full = $file.FullName
                if (-not $seen.Add($full)) { continue }
                $text = Get-Content -LiteralPath $full -Raw -Encoding UTF8
                $linesInFile = ($text -split '\r?\n').Count
                $totalLines += $linesInFile + 2  # 제목줄 + 내용 + 빈줄
            }
        } catch {
            Write-Host "Error processing wildcard $relPath : $_" -ForegroundColor Red
        }
    } else {
        if (-not (Test-Path -LiteralPath $filePath)) {
            Write-Host "File not found: $filePath" -ForegroundColor Red
            continue
        }
        $full = (Get-Item -LiteralPath $filePath).FullName
        if (-not $seen.Add($full)) { continue }
        $text = Get-Content -LiteralPath $filePath -Raw -Encoding UTF8
        $linesInFile = ($text -split '\r?\n').Count
        $totalLines += $linesInFile + 2  # 제목줄 + 내용 + 빈줄
    }
}

# 총 파일 개수 계산
$totalFiles = [Math]::Ceiling($totalLines / $maxLinesPerFile)
Write-Host "Total lines: $totalLines, Total files: $totalFiles"

# Phase 2: 실제 파일 생성 (파트 정보 포함)
$seen.Clear()
$currentLineCount = 0
$fileIndex = 1
$sb = [System.Text.StringBuilder]::new()

function SaveCurrentBuffer {
    if ($sb.Length -eq 0) { return }

    $currentOutPath = if ($fileIndex -eq 1) { $OutPath } else { "$OutPath.$fileIndex" }

    # 파트 정보 추가 (시작)
    $partHeader = "--- PART $fileIndex/$totalFiles ---`n"
    $partFooter = "`n--- END PART $fileIndex/$totalFiles ---"

    $finalContent = $partHeader + $sb.ToString() + $partFooter

    # UTF-8 with BOM으로 저장(메모장 등에서도 한글 안전)
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($currentOutPath, $finalContent, $utf8Bom)

    Write-Host "Created $currentOutPath with $currentLineCount lines (PART $fileIndex/$totalFiles)"

    # 다음 파일 준비
    $sb.Clear()
    $script:currentLineCount = 0
    $script:fileIndex++
}

foreach ($relPath in $lines) {
    # 경로 구분자 표준화: / → \ (Windows 호환성)
    $relPath = $relPath -replace '/', '\'

    # ✅ 상대경로는 '프로젝트 루트' 기준
    $filePath = if ([IO.Path]::IsPathRooted($relPath)) { $relPath }
                else { Join-Path $ProjectRoot $relPath }

    # 와일드카드(*) 지원: *가 포함되면 Get-ChildItem으로 확장
    if ($relPath -like '*[*]*') {
        try {
            $matchedFiles = Get-ChildItem -Path $filePath -File -ErrorAction Stop
            if ($matchedFiles.Count -eq 0) {
                Write-Host "No files matched: $relPath" -ForegroundColor Yellow
                continue
            }
            foreach ($file in $matchedFiles) {
                $full = $file.FullName
                if (-not $seen.Add($full)) { continue }

                # 파일을 UTF-8로 강제 읽기
                $text = Get-Content -LiteralPath $full -Raw -Encoding UTF8

                # 줄 수 계산 및 파일 분할 체크
                $linesInFile = ($text -split '\r?\n').Count
                if ($currentLineCount + $linesInFile + 2 -gt $maxLinesPerFile -and $currentLineCount -gt 0) {
                    SaveCurrentBuffer
                }

                # 제목 줄에 실제 파일 경로 남김
                $relFilePath = $full.Substring($ProjectRoot.Length + 1).Replace('\', '/')
                [void]$sb.AppendLine($relFilePath)
                $currentLineCount++

                # 파일 내용 추가
                [void]$sb.AppendLine($text)
                $currentLineCount += $linesInFile
                [void]$sb.AppendLine()
                $currentLineCount++
            }
        } catch {
            Write-Host "Error processing wildcard $relPath : $_" -ForegroundColor Red
        }
    } else {
        # 일반 파일 처리
        if (-not (Test-Path -LiteralPath $filePath)) {
            Write-Host "File not found: $filePath" -ForegroundColor Red
            continue
        }

        $full = (Get-Item -LiteralPath $filePath).FullName
        if (-not $seen.Add($full)) { continue }

        # 제목 줄에 프로젝트 루트 기준 상대 경로로 남김
        $relFilePath = $full.Substring($ProjectRoot.Length + 1).Replace('\', '/')
        [void]$sb.AppendLine($relFilePath)
        $currentLineCount++

        # 파일을 UTF-8로 강제 읽기
        $text = Get-Content -LiteralPath $filePath -Raw -Encoding UTF8

        # 줄 수 계산 및 파일 분할 체크
        $linesInFile = ($text -split '\r?\n').Count
        if ($currentLineCount + $linesInFile + 1 -gt $maxLinesPerFile -and $currentLineCount -gt 0) {
            SaveCurrentBuffer
        }

        # 파일 내용 추가
        [void]$sb.AppendLine($text)
        $currentLineCount += $linesInFile
        [void]$sb.AppendLine()
        $currentLineCount++
    }
}

# 남은 버퍼 저장
SaveCurrentBuffer

Write-Host "ProjectRoot = $ProjectRoot"
Write-Host "Source files created successfully. Total files: $($fileIndex - 1)"

# 첫 번째 파일을 VS Code에서 열기
try {
    & code $OutPath
    Write-Host "Opened $OutPath in VS Code"
} catch {
    Write-Host "Failed to open $OutPath in VS Code: $_" -ForegroundColor Yellow
}
