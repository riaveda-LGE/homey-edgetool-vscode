package logviewer

import (
	"strings"
	"time"
)

// LogFilter는 로그 필터링 기능을 제공합니다
type LogFilter struct {
	TextFilter  string    // 텍스트 검색 필터
	LevelFilter string    // 로그 레벨 필터
	TagFilter   string    // 태그 필터
	TimeFrom    time.Time // 시작 시간 필터
	TimeTo      time.Time // 종료 시간 필터
	ShowLevels  map[string]bool // 표시할 레벨들
}

// NewLogFilter는 새로운 LogFilter를 생성합니다
func NewLogFilter() *LogFilter {
	return &LogFilter{
		LevelFilter: LevelAll,
		TagFilter:   "ALL",
		ShowLevels: map[string]bool{
			LevelError: true,
			LevelWarn:  true,
			LevelInfo:  true,
			LevelDebug: true,
			LevelTrace: true,
		},
	}
}

// ApplyFilter는 로그 엔트리 목록에 필터를 적용합니다
func (f *LogFilter) ApplyFilter(entries []*LogEntry) []*LogEntry {
	if f.IsEmpty() {
		return entries
	}
	
	filtered := make([]*LogEntry, 0)
	
	for _, entry := range entries {
		if f.MatchesFilter(entry) {
			filtered = append(filtered, entry)
		}
	}
	
	return filtered
}

// MatchesFilter는 개별 로그 엔트리가 필터와 일치하는지 확인합니다
func (f *LogFilter) MatchesFilter(entry *LogEntry) bool {
	// 텍스트 필터 확인
	if f.TextFilter != "" {
		text := strings.ToLower(f.TextFilter)
		if !strings.Contains(strings.ToLower(entry.Message), text) &&
		   !strings.Contains(strings.ToLower(entry.Tag), text) &&
		   !strings.Contains(strings.ToLower(entry.RawLine), text) {
			return false
		}
	}
	
	// 레벨 필터 확인
	if f.LevelFilter != "" && f.LevelFilter != LevelAll {
		if entry.Level != f.LevelFilter {
			return false
		}
	}
	
	// 개별 레벨 표시 설정 확인
	if !f.ShowLevels[entry.Level] {
		return false
	}
	
	// 태그 필터 확인
	if f.TagFilter != "" && f.TagFilter != "ALL" {
		if entry.Tag != f.TagFilter {
			return false
		}
	}
	
	// 시간 범위 필터 확인
	if !f.TimeFrom.IsZero() && !f.TimeTo.IsZero() {
		if !entry.Timestamp.IsZero() {
			if entry.Timestamp.Before(f.TimeFrom) || entry.Timestamp.After(f.TimeTo) {
				return false
			}
		}
	}
	
	return true
}

// IsEmpty는 필터가 비어있는지 확인합니다
func (f *LogFilter) IsEmpty() bool {
	return f.TextFilter == "" &&
		   (f.LevelFilter == "" || f.LevelFilter == LevelAll) &&
		   (f.TagFilter == "" || f.TagFilter == "ALL") &&
		   f.TimeFrom.IsZero() &&
		   f.TimeTo.IsZero() &&
		   f.allLevelsEnabled()
}

// allLevelsEnabled는 모든 레벨이 활성화되어 있는지 확인합니다
func (f *LogFilter) allLevelsEnabled() bool {
	for _, enabled := range f.ShowLevels {
		if !enabled {
			return false
		}
	}
	return true
}

// SetTextFilter는 텍스트 필터를 설정합니다
func (f *LogFilter) SetTextFilter(text string) {
	f.TextFilter = strings.TrimSpace(text)
}

// SetLevelFilter는 레벨 필터를 설정합니다
func (f *LogFilter) SetLevelFilter(level string) {
	f.LevelFilter = level
}

// SetTagFilter는 태그 필터를 설정합니다
func (f *LogFilter) SetTagFilter(tag string) {
	f.TagFilter = tag
}

// SetTimeRange는 시간 범위를 설정합니다
func (f *LogFilter) SetTimeRange(from, to time.Time) {
	f.TimeFrom = from
	f.TimeTo = to
}

// ToggleLevel은 특정 레벨의 표시/숨김을 토글합니다
func (f *LogFilter) ToggleLevel(level string) {
	if f.ShowLevels == nil {
		f.ShowLevels = make(map[string]bool)
	}
	f.ShowLevels[level] = !f.ShowLevels[level]
}

// SetLevelVisible는 특정 레벨의 표시 여부를 설정합니다
func (f *LogFilter) SetLevelVisible(level string, visible bool) {
	if f.ShowLevels == nil {
		f.ShowLevels = make(map[string]bool)
	}
	f.ShowLevels[level] = visible
}

// IsLevelVisible는 특정 레벨이 표시되는지 확인합니다
func (f *LogFilter) IsLevelVisible(level string) bool {
	if f.ShowLevels == nil {
		return true
	}
	visible, exists := f.ShowLevels[level]
	return !exists || visible
}

// Clear는 모든 필터를 초기화합니다
func (f *LogFilter) Clear() {
	f.TextFilter = ""
	f.LevelFilter = LevelAll
	f.TagFilter = "ALL"
	f.TimeFrom = time.Time{}
	f.TimeTo = time.Time{}
	f.ShowLevels = map[string]bool{
		LevelError: true,
		LevelWarn:  true,
		LevelInfo:  true,
		LevelDebug: true,
		LevelTrace: true,
	}
}

// GetActiveFiltersCount는 활성화된 필터의 개수를 반환합니다
func (f *LogFilter) GetActiveFiltersCount() int {
	count := 0
	
	if f.TextFilter != "" {
		count++
	}
	if f.LevelFilter != "" && f.LevelFilter != LevelAll {
		count++
	}
	if f.TagFilter != "" && f.TagFilter != "ALL" {
		count++
	}
	if !f.TimeFrom.IsZero() || !f.TimeTo.IsZero() {
		count++
	}
	if !f.allLevelsEnabled() {
		count++
	}
	
	return count
}

// GetFilterSummary는 현재 필터 상태의 요약을 반환합니다
func (f *LogFilter) GetFilterSummary() string {
	if f.IsEmpty() {
		return "필터 없음"
	}
	
	parts := make([]string, 0)
	
	if f.TextFilter != "" {
		parts = append(parts, "텍스트: "+f.TextFilter)
	}
	if f.LevelFilter != "" && f.LevelFilter != LevelAll {
		parts = append(parts, "레벨: "+f.LevelFilter)
	}
	if f.TagFilter != "" && f.TagFilter != "ALL" {
		parts = append(parts, "태그: "+f.TagFilter)
	}
	if !f.allLevelsEnabled() {
		hiddenCount := 0
		for _, enabled := range f.ShowLevels {
			if !enabled {
				hiddenCount++
			}
		}
		parts = append(parts, strings.Join([]string{"숨김 레벨: ", string(rune(hiddenCount)), "개"}, ""))
	}
	
	return strings.Join(parts, ", ")
}

// ExtractUniqueTags는 로그 엔트리들에서 고유한 태그 목록을 추출합니다
func ExtractUniqueTags(entries []*LogEntry) []string {
	tagSet := make(map[string]bool)
	tags := []string{"ALL"} // 기본 옵션
	
	for _, entry := range entries {
		if entry.Tag != "" && !tagSet[entry.Tag] {
			tagSet[entry.Tag] = true
			tags = append(tags, entry.Tag)
		}
	}
	
	return tags
}

// ExtractUniqueLevels는 로그 엔트리들에서 고유한 레벨 목록을 추출합니다
func ExtractUniqueLevels(entries []*LogEntry) []string {
	levelSet := make(map[string]bool)
	levels := []string{LevelAll} // 기본 옵션
	
	// 표준 순서로 레벨 추가
	standardLevels := []string{LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace}
	
	for _, level := range standardLevels {
		for _, entry := range entries {
			if entry.Level == level && !levelSet[level] {
				levelSet[level] = true
				levels = append(levels, level)
				break
			}
		}
	}
	
	// 기타 레벨들 추가
	for _, entry := range entries {
		if entry.Level != "" && !levelSet[entry.Level] {
			levelSet[entry.Level] = true
			levels = append(levels, entry.Level)
		}
	}
	
	return levels
}
