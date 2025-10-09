package logviewer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// LogBookmark는 로그 북마크를 나타냅니다
type LogBookmark struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	LineIndex int       `json:"lineIndex"`
	Timestamp time.Time `json:"timestamp"`
	Note      string    `json:"note"`
	LogEntry  *LogEntry `json:"logEntry,omitempty"` // 북마크된 로그 엔트리
}

// BookmarkManager는 북마크를 관리합니다
type BookmarkManager struct {
	bookmarks  []*LogBookmark
	nextID     int
	configFile string
}

// NewBookmarkManager는 새로운 BookmarkManager를 생성합니다
func NewBookmarkManager(configFile string) *BookmarkManager {
	bm := &BookmarkManager{
		bookmarks:  make([]*LogBookmark, 0),
		nextID:     1,
		configFile: configFile,
	}
	
	// 기존 북마크 로드
	bm.LoadBookmarks()
	
	return bm
}

// AddBookmark는 새로운 북마크를 추가합니다
func (bm *BookmarkManager) AddBookmark(name string, lineIndex int, entry *LogEntry, note string) *LogBookmark {
	bookmark := &LogBookmark{
		ID:        bm.nextID,
		Name:      name,
		LineIndex: lineIndex,
		Timestamp: time.Now(),
		Note:      note,
		LogEntry:  entry,
	}
	
	bm.bookmarks = append(bm.bookmarks, bookmark)
	bm.nextID++
	
	// 자동 저장
	bm.SaveBookmarks()
	
	return bookmark
}

// RemoveBookmark는 북마크를 제거합니다
func (bm *BookmarkManager) RemoveBookmark(id int) bool {
	for i, bookmark := range bm.bookmarks {
		if bookmark.ID == id {
			// 슬라이스에서 제거
			bm.bookmarks = append(bm.bookmarks[:i], bm.bookmarks[i+1:]...)
			bm.SaveBookmarks()
			return true
		}
	}
	return false
}

// GetBookmarks는 모든 북마크를 반환합니다
func (bm *BookmarkManager) GetBookmarks() []*LogBookmark {
	return bm.bookmarks
}

// GetBookmark는 특정 ID의 북마크를 반환합니다
func (bm *BookmarkManager) GetBookmark(id int) *LogBookmark {
	for _, bookmark := range bm.bookmarks {
		if bookmark.ID == id {
			return bookmark
		}
	}
	return nil
}

// UpdateBookmark는 북마크 정보를 업데이트합니다
func (bm *BookmarkManager) UpdateBookmark(id int, name, note string) bool {
	bookmark := bm.GetBookmark(id)
	if bookmark == nil {
		return false
	}
	
	bookmark.Name = name
	bookmark.Note = note
	
	bm.SaveBookmarks()
	return true
}

// LoadBookmarks는 파일에서 북마크를 로드합니다
func (bm *BookmarkManager) LoadBookmarks() error {
	if _, err := os.Stat(bm.configFile); os.IsNotExist(err) {
		return nil // 파일이 없으면 빈 상태로 시작
	}
	
	data, err := os.ReadFile(bm.configFile)
	if err != nil {
		return fmt.Errorf("북마크 파일 읽기 실패: %v", err)
	}
	
	var savedData struct {
		Bookmarks []*LogBookmark `json:"bookmarks"`
		NextID    int            `json:"nextId"`
	}
	
	if err := json.Unmarshal(data, &savedData); err != nil {
		return fmt.Errorf("북마크 파일 파싱 실패: %v", err)
	}
	
	bm.bookmarks = savedData.Bookmarks
	bm.nextID = savedData.NextID
	
	return nil
}

// SaveBookmarks는 북마크를 파일에 저장합니다
func (bm *BookmarkManager) SaveBookmarks() error {
	// 디렉토리 생성
	dir := filepath.Dir(bm.configFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("북마크 디렉토리 생성 실패: %v", err)
	}
	
	saveData := struct {
		Bookmarks []*LogBookmark `json:"bookmarks"`
		NextID    int            `json:"nextId"`
	}{
		Bookmarks: bm.bookmarks,
		NextID:    bm.nextID,
	}
	
	data, err := json.MarshalIndent(saveData, "", "  ")
	if err != nil {
		return fmt.Errorf("북마크 JSON 변환 실패: %v", err)
	}
	
	if err := os.WriteFile(bm.configFile, data, 0644); err != nil {
		return fmt.Errorf("북마크 파일 저장 실패: %v", err)
	}
	
	return nil
}

// Clear는 모든 북마크를 삭제합니다
func (bm *BookmarkManager) Clear() {
	bm.bookmarks = make([]*LogBookmark, 0)
	bm.nextID = 1
	bm.SaveBookmarks()
}

// GetBookmarkNames는 북마크 이름 목록을 반환합니다 (UI 선택 박스용)
func (bm *BookmarkManager) GetBookmarkNames() []string {
	names := make([]string, len(bm.bookmarks))
	for i, bookmark := range bm.bookmarks {
		names[i] = fmt.Sprintf("%d. %s", bookmark.ID, bookmark.Name)
	}
	return names
}

// FindBookmarkByLineIndex는 특정 라인 인덱스의 북마크를 찾습니다
func (bm *BookmarkManager) FindBookmarkByLineIndex(lineIndex int) *LogBookmark {
	for _, bookmark := range bm.bookmarks {
		if bookmark.LineIndex == lineIndex {
			return bookmark
		}
	}
	return nil
}

// IsBookmarked는 특정 라인이 북마크되어 있는지 확인합니다
func (bm *BookmarkManager) IsBookmarked(lineIndex int) bool {
	return bm.FindBookmarkByLineIndex(lineIndex) != nil
}

// GetFormattedString은 북마크의 포맷된 문자열을 반환합니다
func (bookmark *LogBookmark) GetFormattedString() string {
	timeStr := bookmark.Timestamp.Format("15:04:05")
	if bookmark.LogEntry != nil && bookmark.LogEntry.TimeStr != "" {
		timeStr = bookmark.LogEntry.TimeStr
	}
	
	result := fmt.Sprintf("[%s] %s", timeStr, bookmark.Name)
	if bookmark.Note != "" {
		result += fmt.Sprintf(" - %s", bookmark.Note)
	}
	
	return result
}
