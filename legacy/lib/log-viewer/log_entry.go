package logviewer

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// LogEntry는 파싱된 로그 항목을 나타냅니다
type LogEntry struct {
	ID        int64     `json:"id"`        // 유니크 로그 ID (버퍼 관리용)
	Index     int       `json:"index"`     // 로그 순서 인덱스
	Timestamp time.Time `json:"timestamp"` // 파싱된 시간
	TimeStr   string    `json:"timeStr"`   // 원본 시간 문자열
	Level     string    `json:"level"`     // ERROR, WARN, INFO, DEBUG 등
	Tag       string    `json:"tag"`       // 태그/모듈명
	PID       string    `json:"pid"`       // 프로세스 ID
	Message   string    `json:"message"`   // 실제 메시지
	Type      string    `json:"type"`      // 로그 타입 (system, application, network, security 등)
	Source    string    `json:"source"`    // 로그 출처 (파일명 등)
	RawLine   string    `json:"rawLine"`   // 원본 라인
}

// LogLevel 상수 정의
const (
	LevelError = "ERROR"
	LevelWarn  = "WARN"
	LevelInfo  = "INFO"
	LevelDebug = "DEBUG"
	LevelTrace = "TRACE"
	LevelAll   = "ALL"
)

// 일반적인 로그 패턴들 (Android logcat, journalctl 등)
var logPatterns = []*regexp.Regexp{
	// Homey 로그 패턴: [Dec 24 10:50:33.990] bt_player[210]: message 또는 [Dec 24 10:50:31.628] kernel: message
	regexp.MustCompile(`^\[([A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\]\s+([^:\[]+)(?:\[(\d+)\])?:\s*(.*)$`),
}

// ParseLogLine은 로그 라인을 파싱하여 LogEntry를 생성합니다
// 패턴 매칭이 되는 로그만 처리하고, 매칭되지 않으면 nil을 반환합니다
func ParseLogLine(line string, index int) *LogEntry {
	entry := &LogEntry{
		Index:   index,
		RawLine: line,
		Message: strings.TrimSpace(line), // 기본값은 전체 라인 (공백 제거)
		Type:    "application",           // 기본 로그 타입
	}

	// 빈 라인 처리
	if strings.TrimSpace(line) == "" {
		entry.Level = LevelInfo
		entry.Message = "(빈 줄)"
		entry.TimeStr = time.Now().Format("15:04:05")
		return entry
	}

	// 각 패턴을 시도해서 매칭되는 것 찾기
	patternMatched := false
	for _, pattern := range logPatterns {
		matches := pattern.FindStringSubmatch(line)
		if len(matches) > 0 {
			parseWithPattern(entry, matches, pattern)
			patternMatched = true
			break
		}
	}

	// 패턴 매칭 실패 시 nil 반환 (필터링)
	if !patternMatched {
		return nil // 패턴 매칭되지 않는 로그는 무시
	}

	// 로그 레벨 정규화
	normalizeLogLevel(entry)

	// 최종 검증: 필수 필드가 비어있으면 기본값 설정
	if entry.TimeStr == "" {
		entry.TimeStr = time.Now().Format("15:04:05")
	}
	if entry.Level == "" {
		entry.Level = LevelInfo
	}
	if entry.Message == "" {
		entry.Message = strings.TrimSpace(line)
	}

	return entry
}

// parseWithPattern은 특정 패턴으로 로그를 파싱합니다
func parseWithPattern(entry *LogEntry, matches []string, pattern *regexp.Regexp) {
	patternStr := pattern.String()

	switch {
	case strings.Contains(patternStr, `[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3}`): // Homey 로그 패턴
		if len(matches) >= 4 {
			entry.TimeStr = matches[1] // 시간: "Dec 24 10:50:33.990"
			entry.Tag = matches[2]     // 태그: "bt_player" 또는 "kernel"
			if len(matches) >= 5 && matches[3] != "" {
				entry.PID = matches[3] // PID: "210" (있으면)
			}
			entry.Message = matches[4] // 메시지
			entry.Level = LevelInfo    // 기본 INFO 레벨

			// Timestamp 파싱 (TimeStr → time.Time)
			if parsedTime, err := parseHomeyTimeString(matches[1]); err == nil {
				entry.Timestamp = parsedTime
			} else {
				// 파싱 실패 시 현재 시간 사용
				entry.Timestamp = time.Now()
			}

			if strings.Contains(strings.ToLower(entry.Tag), "kernel") {
				entry.Type = "kernel" // kernel 타입 지정
			} else {
				entry.Type = "application" // 기본 application 타입
			}
		}
	}
}

// parseHomeyTimeString은 Homey 로그의 시간 문자열을 time.Time으로 파싱합니다
func parseHomeyTimeString(timeStr string) (time.Time, error) {
	// timeStr 형식: "Dec 24 10:50:33.990"

	// 현재 연도 사용 (연도 정보가 없으므로)
	currentYear := time.Now().Year()

	// 연도를 추가한 전체 시간 문자열 생성
	fullTimeStr := fmt.Sprintf("%d %s", currentYear, timeStr)

	// 시간 파싱 시도
	layouts := []string{
		"2006 Jan 2 15:04:05.000",  // "2024 Dec 24 10:50:33.990"
		"2006 Jan 02 15:04:05.000", // "2024 Dec 24 10:50:33.990" (일자 2자리)
	}

	for _, layout := range layouts {
		if parsedTime, err := time.Parse(layout, fullTimeStr); err == nil {
			return parsedTime, nil
		}
	}

	return time.Time{}, fmt.Errorf("시간 파싱 실패: %s", timeStr)
}

// parseBasicLog은 패턴 매칭 실패 시 기본 파싱을 수행합니다
func parseBasicLog(entry *LogEntry, line string) {
	// 빈 라인이거나 주석 라인 처리
	if strings.TrimSpace(line) == "" {
		entry.Type = "system"
		return
	}

	// # 으로 시작하는 주석/시스템 메시지 처리
	if strings.HasPrefix(strings.TrimSpace(line), "#") {
		entry.Level = LevelInfo
		entry.Tag = "System"
		entry.Message = strings.TrimSpace(line)
		entry.TimeStr = time.Now().Format("15:04:05")
		entry.Type = "system"
		return
	}

	// 메시지 내용에 따라 타입 결정 (system 또는 kernel만 사용)
	lineLower := strings.ToLower(line)
	if strings.Contains(lineLower, "kernel") || strings.Contains(lineLower, "dmesg") ||
		strings.Contains(lineLower, "kern") || strings.Contains(lineLower, "klog") {
		entry.Type = "kernel"
	} else {
		entry.Type = "system" // 기본값은 system
	}

	// 시간 패턴 찾기
	timePatterns := []string{
		`\d{2}:\d{2}:\d{2}`,
		`\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}`,
		`\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}`,
	}

	for _, timePattern := range timePatterns {
		re := regexp.MustCompile(timePattern)
		if match := re.FindString(line); match != "" {
			entry.TimeStr = match
			break
		}
	}

	// 시간이 없으면 현재 시간 사용
	if entry.TimeStr == "" {
		entry.TimeStr = time.Now().Format("15:04:05")
	}

	// 로그 레벨 찾기
	levelPattern := regexp.MustCompile(`\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|E|W|I|D|V|F)\b`)
	if match := levelPattern.FindString(strings.ToUpper(line)); match != "" {
		entry.Level = match
	} else {
		entry.Level = LevelInfo // 기본값
	}

	// 메시지가 비어있으면 전체 라인 사용
	if entry.Message == "" || entry.Message == line {
		entry.Message = strings.TrimSpace(line)
	}

	// 태그가 비어있으면 기본값 설정
	if entry.Tag == "" {
		if strings.Contains(strings.ToLower(line), "edge") {
			entry.Tag = "EdgeTool"
		} else if strings.Contains(strings.ToLower(line), "homey") {
			entry.Tag = "Homey"
		} else {
			entry.Tag = "App"
		}
	}
}

// androidLevelToStandard는 Android 로그 레벨을 표준 레벨로 변환합니다
func androidLevelToStandard(level string) string {
	switch level {
	case "V":
		return LevelTrace
	case "D":
		return LevelDebug
	case "I":
		return LevelInfo
	case "W":
		return LevelWarn
	case "E", "F":
		return LevelError
	default:
		return level
	}
}

// normalizeLogLevel은 로그 레벨을 표준화합니다
func normalizeLogLevel(entry *LogEntry) {
	level := strings.ToUpper(entry.Level)
	switch level {
	case "E", "ERR", "ERROR", "FATAL", "F":
		entry.Level = LevelError
	case "W", "WARN", "WARNING":
		entry.Level = LevelWarn
	case "I", "INFO":
		entry.Level = LevelInfo
	case "D", "DEBUG":
		entry.Level = LevelDebug
	case "V", "VERBOSE", "TRACE":
		entry.Level = LevelTrace
	default:
		if entry.Level == "" {
			entry.Level = LevelInfo // 기본값
		}
	}
}

// GetAvailableLevels는 사용 가능한 로그 레벨 목록을 반환합니다
func GetAvailableLevels() []string {
	return []string{LevelAll, LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace}
}

// MatchesFilter는 로그 엔트리가 필터와 일치하는지 확인합니다
func (entry *LogEntry) MatchesFilter(textFilter, levelFilter, tagFilter string) bool {
	// 텍스트 필터 확인
	if textFilter != "" {
		if !strings.Contains(strings.ToLower(entry.Message), strings.ToLower(textFilter)) {
			return false
		}
	}

	// 레벨 필터 확인
	if levelFilter != "" && levelFilter != LevelAll {
		if entry.Level != levelFilter {
			return false
		}
	}

	// 태그 필터 확인
	if tagFilter != "" && tagFilter != "ALL" {
		if entry.Tag != tagFilter {
			return false
		}
	}

	return true
}
