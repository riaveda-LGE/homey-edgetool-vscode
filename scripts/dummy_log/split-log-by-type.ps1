# split-log-by-type.ps1
# Usage examples:
#   .\scripts\dummy_log\split-log-by-type.ps1 -InFile merged.log
#   .\scripts\dummy_log\split-log-by-type.ps1 -InFile .\merged.log -OutDir ~\before_log\ -Rotation 3
#   .\scripts\dummy_log\split-log-by-type.ps1 -InFile merged.log -OutDir out_split -Rotation 5 -Others others.log
#
# Help:
#   .\scripts\dummy_log\split-log-by-type.ps1 -Help

param(
    [string]$InFile = "merged.log",

    [string]$OutDir = "out_split",

    [int]$Rotation = 3,

    [string]$Others,

    [switch]$Help
)

# ──────────────────────────────────────────────────────────────
# Process positional arguments and handle directory/file logic
# ──────────────────────────────────────────────────────────────
$positionalArgs = $args | Where-Object { $_ -notmatch '^-' }

if ($positionalArgs.Count -ge 1) {
    $InFile = $positionalArgs[0]
}
if ($positionalArgs.Count -ge 2) {
    $OutDir = $positionalArgs[1]
}

# If InFile is a directory, assume merged.log inside it
if (Test-Path $InFile -PathType Container) {
    $InFile = Join-Path $InFile "merged.log"
}

# ──────────────────────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────────────────────
if ($Help) {
    $help = @"
Homey merged.log splitter (group by process type with rotation)

DESCRIPTION
  merged.log를 위에서 아래로 읽으며 프로세스명으로 타입을 식별하고,
  타입별로 모은 라인을 "회전 파일"로 나눠 저장합니다.
  - 최신 내용: <type>.log
  - 더 오래된 내용: <type>.log.1, <type>.log.2 ... (숫자가 클수록 오래됨)

USAGE
  .\split-log-by-type.ps1 -InFile <file> [-OutDir <dir>] [-Rotation <N>] [-Others <file>]

OPTIONS
  -InFile <file>     입력 merged 로그 파일 (기본: merged.log)
  -OutDir <dir>      타입별 결과 파일 디렉터리 (기본: out_split)
  -Rotation <N>      타입별 회전 파일 개수 (기본: 3, 최소 1, 최대 10)
  -Others <file>     매칭되지 않는 라인을 별도 파일로 저장 (옵션)
  -Help              도움말

TYPE MAPPING
  kernel            → kernel.log
  clip.bin          → clip.log
  cpcd              → cpcd.log
  homey-matter      → matter.log
  otbr-agent        → otbr-agent.log
  systemd, rc.local → system.log
  homey-z3gateway   → z3gateway.log
  bt_player         → bt_player.log

NOTE
  프로세스명 추출 정규식(대괄호 타임스탬프 전제):
    ^\\[[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d{3,6}\\]\\s+([A-Za-z0-9._-]+)(?:\\[|:)
  - 월: 3-letter (예: Jan, Oct)
  - 일: 1~2자리
  - 밀리초: 3~6자리
"@
    Write-Host $help
    exit 0
}

# ──────────────────────────────────────────────────────────────
# Expand tilde
# ──────────────────────────────────────────────────────────────
function Expand-Tilde {
    param([string]$Path)
    if (!$Path) { return $Path }
    if ($Path -eq '~') { return $env:USERPROFILE }
    if ($Path.StartsWith('~/') -or $Path.StartsWith('~\')) {
        return Join-Path $env:USERPROFILE $Path.Substring(2)
    }
    return $Path
}

$InFile = Expand-Tilde $InFile
$OutDir = Expand-Tilde $OutDir
if ($Others) { $Others = Expand-Tilde $Others }

$Rotation = [math]::Max(1, [math]::Min(10, $Rotation))

# ──────────────────────────────────────────────────────────────
# Type mapping (processName → fileName base)
# ──────────────────────────────────────────────────────────────
function Map-ProcessToType {
    param([string]$proc)
    if (!$proc) { return $null }
    switch ($proc) {
        'kernel' { return @{ type = 'kernel'; file = 'kernel.log' } }
        'clip.bin' { return @{ type = 'clip'; file = 'clip.log' } }
        'cpcd' { return @{ type = 'cpcd'; file = 'cpcd.log' } }
        'homey-matter' { return @{ type = 'matter'; file = 'matter.log' } }
        'otbr-agent' { return @{ type = 'otbr-agent'; file = 'otbr-agent.log' } }
        'homey-z3gateway' { return @{ type = 'z3gateway'; file = 'z3gateway.log' } }
        'bt_player' { return @{ type = 'bt_player'; file = 'bt_player.log' } }
        { $_ -in @('systemd', 'rc.local') } { return @{ type = 'system'; file = 'system.log' } }
        default { return $null }
    }
}

# [Mon DD HH:MM:SS.mmm] <proc>[... or : ...
$RE = '^\[[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6}\]\s+([A-Za-z0-9._-]+)(?:\[|:)'

if (!(Test-Path $InFile)) {
    Write-Error "❌ input not found: $InFile"
    exit 1
}

if (!(Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# 모으기: 타입별 라인 배열
$perType = @{}        # type -> string[]
$baseFileName = @{}   # type -> 'kernel.log' 등
$unknownLines = @()

$lines = Get-Content $InFile -Encoding UTF8
foreach ($line in $lines) {
    if (!$line) { continue } # 빈 줄 스킵
    if ($line -match $RE) {
        $proc = $matches[1]
        $map = Map-ProcessToType $proc
        if ($map) {
            if (!$perType.ContainsKey($map.type)) { $perType[$map.type] = @() }
            $perType[$map.type] += $line
            $baseFileName[$map.type] = $map.file
        } elseif ($Others) {
            $unknownLines += $line
        }
    } elseif ($Others) {
        $unknownLines += $line
    }
}

# 쓰기: 타입별 로테이션 분할
$summary = @()
foreach ($type in $perType.Keys) {
    $arr = $perType[$type]
    $total = $arr.Length
    if ($total -eq 0) { continue }

    # 실제 생성할 파트 수 (빈 파일은 만들지 않음)
    $parts = [math]::Min($Rotation, $total)

    # 균등 분할(앞쪽 파트에 1줄씩 더)
    $base = [math]::Floor($total / $parts)
    $rem = $total % $parts
    $offset = 0

    $baseFile = $baseFileName[$type]
    $created = @()

    for ($part = 0; $part -lt $parts; $part++) {
        $count = $base
        if ($part -lt $rem) { $count += 1 }
        $seg = $arr[$offset..($offset + $count - 1)]
        $offset += $count

        # 최신(마지막 파트)이 .log, 그 이전은 .log.1, ... 가장 오래된(첫 파트)이 .log.(parts-1)
        $suffixIndex = $parts - 1 - $part
        $fileName = $baseFile
        if ($suffixIndex -ne 0) { $fileName = "$baseFile.$suffixIndex" }
        $full = Join-Path $OutDir $fileName
        $seg -join "`n" | Set-Content -Path $full -Encoding UTF8
        $created += @{ file = $fileName; lines = $seg.Length }
    }

    $summary += @{ type = $type; total = $total; created = $created }
}

# others (옵션)
if ($Others -and $unknownLines.Length -gt 0) {
    $dir = Split-Path $Others -Parent
    if ($dir -and !(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $unknownLines -join "`n" | Set-Content -Path $Others -Encoding UTF8
}

# 출력
Write-Host "✅ split (with rotation x$Rotation) → $(Resolve-Path $OutDir)"
foreach ($item in ($summary | Sort-Object { $_.type })) {
    Write-Host ("  - {0,-11}: {1,6} lines" -f $item.type, $item.total)
    foreach ($c in $item.created) {
        Write-Host ("      • {0,-20} {1,6}" -f $c.file, $c.lines)
    }
}
if ($Others) {
    $n = $unknownLines.Length
    $msg = if ($n) { "(saved to $Others)" } else { "" }
    Write-Host "  - others   : $n $msg"
}
