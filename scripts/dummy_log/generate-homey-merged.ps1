# generate-homey-merged.ps1
# Usage examples:
#   .\scripts\dummy_log\generate-homey-merged.ps1 -Total 3000 -OutDir .\after_merge\
#   .\scripts\dummy_log\generate-homey-merged.ps1 -Total 3000 -OutFile .\after_merge\merged.log
#   .\scripts\dummy_log\generate-homey-merged.ps1 -Total 8000 -OutFile ~\logs\merged.log -Base 2025-10-20 -Days 2 -Seed 1
#
# Help:
#   .\scripts\dummy_log\generate-homey-merged.ps1 -Help

param(
    [Parameter(Mandatory=$true)]
    [int]$Total,

    [string]$OutFile = "merged.log",

    [string]$OutDir,

    [string]$Base = "2025-10-20",

    [int]$Days = 2,

    [int]$Seed,

    [switch]$Help
)

# ──────────────────────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────────────────────
if ($Help) {
    $help = @"
Homey dummy merged log generator

DESCRIPTION
  8가지 타입(kernel, clip, cpcd, matter, otbr-agent, system, z3gateway, bt_player)을
  2일(기본) 범위에 균등 분포로 합쳐 시간 오름차순 merged.log를 생성합니다.

USAGE
  .\generate-homey-merged.ps1 -Total <N> [-OutFile <file>] [-Base YYYY-MM-DD] [-Days D] [-Seed S]

OUTPUT PATH RULES
  - -OutFile <file> 를 쓰거나,
  - ~ 는 홈 디렉터리로 확장됩니다.

OPTIONS
  -Total <N>         최종 로그 라인 수 (필수)
  -OutFile <file>    출력 파일 경로 (기본: merged.log)
  -OutDir <dir>      출력 디렉터리 (OutFile 대신 사용, merged.log로 저장)
  -Base <YYYY-MM-DD> 시작 날짜(자정) (기본: 2025-10-20)
  -Days <D>          base로부터 일수 범위 (기본: 2)
  -Seed <S>          랜덤 시드 (선택, 재현성)
  -Help              도움말

EXAMPLES
  .\generate-homey-merged.ps1 -Total 3000 -OutFile .\after_merge\merged.log
  .\generate-homey-merged.ps1 -Total 8000 -OutFile ~\logs\merged.log -Seed 1
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

$OutFile = Expand-Tilde $OutFile

# Handle OutDir parameter
if ($OutDir) {
    $OutDir = Expand-Tilde $OutDir
    if (!(Test-Path $OutDir)) {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    }
    $OutFile = Join-Path $OutDir "merged.log"
} else {
    # If OutFile is a directory, append merged.log
    if (Test-Path $OutFile -PathType Container) {
        $OutFile = Join-Path $OutFile "merged.log"
    }
}

# Ensure output directory exists
$OutDir = Split-Path $OutFile -Parent
if ($OutDir -and !(Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# ──────────────────────────────────────────────────────────────
# RNG (seeded optional)
# ──────────────────────────────────────────────────────────────
if ($Seed) {
    # Simple seeded random using .NET
    $script:rng = New-Object System.Random($Seed)
} else {
    $script:rng = New-Object System.Random
}

function Get-RandomInt {
    param([int]$Min, [int]$Max)
    return $script:rng.Next($Min, $Max + 1)
}

function Get-RandomDouble {
    return $script:rng.NextDouble()
}

# ──────────────────────────────────────────────────────────────
# Time helpers ([Mon DD HH:MM:SS.mmm])
# ──────────────────────────────────────────────────────────────
$MONTHS = @('Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec')

function To-Date {
    param([string]$BaseYYYYMMDD)
    $parts = $BaseYYYYMMDD -split '-'
    $year = [int]$parts[0]
    $month = [int]$parts[1] - 1
    $day = [int]$parts[2]
    return Get-Date -Year $year -Month $month -Day $day -Hour 0 -Minute 0 -Second 0 -Millisecond 0
}

$baseDate = To-Date $Base
$rangeMs = $Days * 24 * 60 * 60 * 1000

function Format-2 {
    param([int]$n)
    return "{0:D2}" -f $n
}

function Format-3 {
    param([int]$n)
    return "{0:D3}" -f $n
}

function Format-BracketTs {
    param([long]$ms)
    $d = [DateTime]::FromFileTimeUtc($ms * 10000 + 116444736000000000)
    $mon = $MONTHS[$d.Month - 1]
    $day = Format-2 $d.Day
    $hh = Format-2 $d.Hour
    $mm = Format-2 $d.Minute
    $ss = Format-2 $d.Second
    $ms3 = Format-3 $d.Millisecond
    return "[$mon $day $hh`:$mm`:$ss.$ms3]"
}

# ──────────────────────────────────────────────────────────────
# Generators per type
# ──────────────────────────────────────────────────────────────
$TYPES = @('kernel','clip','cpcd','matter','otbr-agent','system','z3gateway','bt_player')

function Get-MacHex {
    $mac = @()
    for ($i = 0; $i -lt 6; $i++) {
        $mac += "{0:X2}" -f (Get-RandomInt 0 255)
    }
    return $mac -join ':'
}

function Line-Kernel {
    param([long]$ts)
    $msgPool = @(
        "[  $(Get-RandomInt 1000 9000).$(Get-RandomInt 100000 999999)] wlan: Send EAPOL pkt to $(Get-MacHex)",
        "wlan0: ",
        "wlan: Send EAPOL pkt to $(Get-MacHex)",
        "woal_cfg80211_set_rekey_data return: gtk_rekey_offload is DISABLE"
    )
    $m = $msgPool[(Get-RandomInt 0 ($msgPool.Length - 1))]
    return "$(Format-BracketTs $ts) kernel:  $m"
}

function Line-Clip {
    param([long]$ts)
    $processId = Get-RandomInt 200 9999
    $pool = @(
        "[CLIP_INFO] [RX.Cloudlet] Got a packet from Cloudlet (_on_cloudlet_packet:$(Get-RandomInt 100 999))",
        "`t`t`t=================================@@",
        "`t`t`t[RX.Cloudlet] hex :  AA 08 F0 EF 00 46 82 BB",
        "`t`t`t=================================@@",
        "`thexstr_len: [$(Get-RandomInt 8 64)]",
        "[CLIP_INFO] `t`t`tGot MSG_CLOUDLET_RX_PKT for [EF] (_process_cloudlet_rx_pkt_msg:$(Get-RandomInt 100 999))",
        "[CLIP_INFO] `t`t`t=================================@@ (_process_cloudlet_rx_pkt_msg:$(Get-RandomInt 100 999))",
        "@@=================================",
        "[TX.UART]@@ bin: [AA 08 F0 EF 00 46 82 BB ]",
        "[CLIP_INFO] xACGStart : 0, xTtsListCnt : 0, xVoiceState : 1, voice_active_mic : 0, xInPlayState : 0, xInternalSoundState : 0 (voicePlayerThread:$(Get-RandomInt 2000 4000))",
        "[CLIP_INFO] [__] led msgQ get timeout (led_message_handler:$(Get-RandomInt 2000 3000))",
        "[MQTT][CLIP_INFO] [PAHO] KeepAlive Ping Try to Send. try [1"
    )
    $m = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
    return "$(Format-BracketTs $ts) clip.bin[$processId]:  $m"
}

function Line-Cpcd {
    param([long]$ts)
    $processId = Get-RandomInt 1000 9999
    $iso = ([DateTime]::FromFileTimeUtc(($ts - (Get-RandomInt 200 1200)) * 10000 + 116444736000000000)).ToString("yyyy-MM-ddTHH:mm:ss.ffffffZ")
    $tracing = if ((Get-RandomDouble) -gt 0.5) { 'true' } else { 'false' }
    $pool = @(
        "[$iso] Info :   stdout_tracing = $tracing",
        "[$iso] Info :   file_tracing = $tracing",
        "[$iso] Info :   lttng_tracing = $tracing",
        "[$iso] Info :   enable_frame_trace = $tracing"
    )
    $m = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
    return "$(Format-BracketTs $ts) cpcd[$processId]:  $m"
}

function Line-Matter {
    param([long]$ts)
    $processId = Get-RandomInt 1500 3000
    $stamp = "$( [math]::Floor($ts / 1000) ).$("{0:D6}" -f (Get-RandomInt 100000 999999))"
    $pool = @(
        "[info - Matter] Constructing service",
        "[$stamp][$($processId):$($processId)] CHIP:-: initSealStorage Result = 0",
        "[info - MatterDaemon] Using socket: /var/run/homey-shared-sockets/homey-matter.sock",
        "[info - Matter] Initializing service",
        "[$stamp][$($processId):$($processId)] CHIP:TOO: Set up stack"
    )
    $m = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
    return "$(Format-BracketTs $ts) homey-matter[$processId]:  $m"
}

function Line-Otbr {
    param([long]$ts)
    $processId = Get-RandomInt 1600 2000
    $h = Format-2 (Get-RandomInt 0 23)
    $m = Format-2 (Get-RandomInt 0 59)
    $s = Format-2 (Get-RandomInt 0 59)
    $ms = "{0:D3}" -f (Get-RandomInt 0 999)
    $pool = @(
        "$h`:$m`:$s.$ms [D] P-RadioSpinel-: Received spinel frame, flg:0x2, iid:2, tid:9, cmd:PROP_VALUE_IS, key:LAST_STATUS, status:OK",
        "$h`:$m`:$s.$ms [D] SubMac--------: RadioState: Transmit -> Receive",
        "$h`:$m`:$s.$ms [D] Mac-----------: =================="
    )
    $msg = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
    return "$(Format-BracketTs $ts) otbr-agent[$processId]:  $msg"
}

function Line-System {
    param([long]$ts)
    if ((Get-RandomDouble) -lt 0.6) {
        $pool = @(
            "logrotate.service: Deactivated successfully.",
            "Finished Rotate log files."
        )
        $m = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
        return "$(Format-BracketTs $ts) systemd[1]:  $m"
    } else {
        $processId = Get-RandomInt 1000 20000
        $pool = @(
            "lo        no wireless extensions.",
            "sit0      no wireless extensions.",
            "ip6tnl0   no wireless extensions."
        )
        $m = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
        return "$(Format-BracketTs $ts) rc.local[$processId]:  $m"
    }
}

function Line-Z3 {
    param([long]$ts)
    $processId = Get-RandomInt 1800 2500
    $pool = @(
        "[info - Z3GatewayRpcService] SetUpStack",
        "[info - Z3GatewayRpcService] StartZ3Gateway NCP path: /dev/ttyZigbeeNCP",
        "Reset info: $(Get-RandomInt 1 20) (SOFTWARE)"
    )
    $m = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
    return "$(Format-BracketTs $ts) homey-z3gateway[$processId]:  $m"
}

function Line-Bt {
    param([long]$ts)
    $processId = Get-RandomInt 100 999
    $t = "$(Format-2 (Get-RandomInt 0 23))`:$(Format-2 (Get-RandomInt 0 59))`:$(Format-2 (Get-RandomInt 0 59))"
    $id = [math]::Floor($ts / 1000)
    $pool = @(
        "$t, `e[32mINFO `e[0m `e[90mprint_monitor:205:`e[0m  MEDIA <X:X> [$id] play[KIT_STOPPED:000/000000] LED[0] HS[0] hplay[2] H_ID(000:-01) MT[1] vol[50]",
        "$t, `e[32mINFO `e[0m `e[90mprint_monitor:223:`e[0m  TTS   <X:X> [$id] play[KIT_IDLE] vol[60]",
        "$t, `e[32mINFO `e[0m `e[90mprint_monitor:191:`e[0m  BT    <X:X> [$id] power[1] discov[0] conn[0[] play[0] trans[BT_TRANSPORT_DISCONNECT:BT_TRANSPORT_IDLE] vol[64])"
    )
    $m = $pool[(Get-RandomInt 0 ($pool.Length - 1))]
    return "$(Format-BracketTs $ts) bt_player[$processId]:  $m"
}

$gen = @{
    'kernel' = ${function:Line-Kernel}
    'clip' = ${function:Line-Clip}
    'cpcd' = ${function:Line-Cpcd}
    'matter' = ${function:Line-Matter}
    'otbr-agent' = ${function:Line-Otbr}
    'system' = ${function:Line-System}
    'z3gateway' = ${function:Line-Z3}
    'bt_player' = ${function:Line-Bt}
}

# ──────────────────────────────────────────────────────────────
# Build → sort → write
# ──────────────────────────────────────────────────────────────
$N = $TYPES.Length
$baseCount = [math]::Floor($Total / $N)
$remainder = $Total % $N
$plan = @()
foreach ($type in $TYPES) {
    $count = $baseCount
    if ($remainder-- -gt 0) { $count += 1 }
    $plan += @{ type = $type; count = $count }
}

$events = @()
foreach ($item in $plan) {
    $type = $item.type
    $count = $item.count
    $makeLine = $gen[$type]
    for ($i = 0; $i -lt $count; $i++) {
        $tMs = $baseDate.Ticks / 10000 + [math]::Floor((Get-RandomDouble) * $rangeMs)
        $text = & $makeLine $tMs
        $events += @{ ts = $tMs; text = $text; type = $type }
    }
}
$events = $events | Sort-Object { $_.ts } -Descending

# Write without trailing newline
$lines = $events | ForEach-Object { $_.text }
$lines -join "`n" | Set-Content -Path $OutFile -NoNewline -Encoding UTF8

$byType = @{}
foreach ($e in $events) {
    if (!$byType.ContainsKey($e.type)) { $byType[$e.type] = 0 }
    $byType[$e.type]++
}

Write-Host "✅ generated: $(Resolve-Path $OutFile)"
foreach ($t in $TYPES) {
    $count = if ($byType.ContainsKey($t)) { $byType[$t] } else { 0 }
    Write-Host ("  - {0,-11}: {1,6}" -f $t, $count)
}
Write-Host "  = total: $($events.Length)"
