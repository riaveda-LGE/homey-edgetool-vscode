# .\scripts\get_source\extract_source_list_via_function.ps1
# 사용법:
#   1) 인자 없이 실행  → copilot-instructions.md 에 정의된 function/설명 목록을 화면에 출력
#   2) -FunctionName <이름> → 해당 태그가 붙은 파일 경로 목록을 source_list.txt 로 저장
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
  [Parameter(Mandatory = $false, Position = 0)]
  [string]$FunctionName,

  [string]$InstructionsRel = ".github\copilot-instructions.md",
  [string]$OutputRel = "scripts\get_source\source_list.txt"
)

Set-StrictMode -Version Latest

# ─ Paths ─
$WorkspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$instructionsPath = Join-Path $WorkspaceRoot $InstructionsRel
$outputPath       = Join-Path $WorkspaceRoot $OutputRel

if (-not (Test-Path -LiteralPath $instructionsPath)) {
  throw "instructions 파일을 찾을 수 없습니다: $instructionsPath"
}

# ─ Read file ─
$content = Get-Content -LiteralPath $instructionsPath -Encoding UTF8
Write-Verbose ("Total lines: {0}" -f $content.Count)

# ─ No-arg mode: 함수 + 설명 출력 ─
if (-not $FunctionName -or [string]::IsNullOrWhiteSpace($FunctionName)) {
  # 패턴: "### function: <name>" 와 그 다음에 이어지는 "> 설명..." 블록
  $funcRx = '^\s*###\s*function:\s*(?<name>.+?)\s*$'
  $descRx = '^\s*>\s*(?<desc>.+?)\s*$'

  $items = New-Object System.Collections.Generic.List[pscustomobject]
  for ($i = 0; $i -lt $content.Count; $i++) {
    $line = $content[$i]
    $m = [regex]::Match($line, $funcRx)
    if (-not $m.Success) { continue }

    $name = $m.Groups['name'].Value.Trim()
    $descLines = New-Object System.Collections.Generic.List[string]

    # 다음 라인들에서 설명(>)을 수집
    $j = $i + 1
    while ($j -lt $content.Count) {
      $l2 = $content[$j]
      if ([regex]::IsMatch($l2, $funcRx)) { break } # 다음 function 헤더를 만나면 종료
      $m2 = [regex]::Match($l2, $descRx)
      if ($m2.Success) {
        $descLines.Add($m2.Groups['desc'].Value.Trim())
        $j++
        continue
      }
      if ($l2 -match '^\s*$') { $j++; continue }     # 빈 줄은 무시하고 계속 탐색
      # 다른 유형의 라인을 만나면, 설명 블록이 이미 있었다면 종료
      if ($descLines.Count -gt 0) { break }
      $j++
    }

    $desc = ($descLines -join ' ')
    $items.Add([pscustomobject]@{ Name = $name; Desc = $desc })
    $i = $j - 1
  }

  if ($items.Count -eq 0) {
    Write-Host "No function entries found in $instructionsPath"
  } else {
    foreach ($it in $items) {
      Write-Host ("function: {0}" -f $it.Name)
      Write-Host ("description: {0}" -f ("$($it.Desc)"))  # PS5 호환: null-safe 출력
      Write-Host ""
    }
  }
  return
}

# ─ State ─
$files    = New-Object System.Collections.Generic.List[string]
$dirStack = New-Object System.Collections.Generic.List[string]  # 디렉터리만 보관

# 트리 라인: 들여쓰기(│/공백), 브랜치(├─|└─|├-|└-), 이름, 선택적 태그(# ...)
$lineRx = '^(?<prefix>[│\s]*)(?<branch>[├└][─-])\s*(?<name>[^#]+?)(?:\s+#(?<comment>.*))?$'
# 태그는 리터럴 매칭(특수문자 안전)
$tagRx = '#\s*' + [regex]::Escape($FunctionName)

function Get-TreeLevel([string]$prefix) {
  # 한 레벨 토큰: "│  " 또는 "   " → 3문자 단위
  return ([regex]::Matches($prefix, '(?:│\s{2}|\s{3})')).Count
}

foreach ($line in $content) {
  $m = [regex]::Match($line, $lineRx)
  if (-not $m.Success) { continue }

  $prefix = $m.Groups['prefix'].Value
  $nameRaw = $m.Groups['name'].Value.TrimEnd()
  $isDir = $nameRaw.TrimEnd().EndsWith('/')
  $name  = $nameRaw.TrimEnd('/').Trim()

  $level = Get-TreeLevel $prefix

  # 현재 라인의 부모 레벨에 맞게 "디렉터리 스택" 정리
  while ($dirStack.Count -gt $level) { $dirStack.RemoveAt($dirStack.Count - 1) }

  if ($isDir) {
    # 디렉터리만 스택에 push (파일은 push 금지)
    $dirStack.Add($name)
    continue
  }

  # 파일이고 태그 매칭되면 경로 생성 후 수집
  if ([regex]::IsMatch($line, $tagRx)) {
    $path = if ($dirStack.Count) { ($dirStack -join '/') + '/' + $name } else { $name }
    $files.Add($path)
    Write-Verbose ("Found file: {0}" -f $path)
  }
}

# 중복 제거 + 정렬
$unique = $files | Sort-Object -Unique

# 출력 디렉터리 보장
$outDir = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $outDir)) {
  $null = New-Item -ItemType Directory -Path $outDir -Force
}

# 기존 파일 삭제 후 새로 저장
if (Test-Path -LiteralPath $outputPath) {
  if ($PSCmdlet.ShouldProcess($outputPath, "Remove existing output")) {
    Remove-Item -LiteralPath $outputPath -Force
  }
}

# 저장(ShouldProcess로 WhatIf/Confirm 지원)
if ($PSCmdlet.ShouldProcess($outputPath, "Write source list")) {
  $unique | Out-File -FilePath $outputPath -Encoding UTF8
  Write-Host ("기능 '{0}' 태그가 붙은 파일 리스트를 {1} 에 저장 완료. 총 {2}개 파일" -f $FunctionName, $outputPath, $unique.Count)
}