package logviewer

import (
	"edgetool/util"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// saveLogs는 로그들을 파일에 저장합니다
func (lfs *LogFileStorage) saveLogs(logs []LogEntry) error {
	lfs.mutex.Lock()
	defer lfs.mutex.Unlock()

	if len(logs) == 0 {
		return nil
	}

	// 현재 파일이 없거나 크기 초과 시 새 파일 생성
	if lfs.currentFile == "" || lfs.currentSize >= lfs.maxFileSize {
		lfs.createNewFile()
	}

	// 파일에 로그들 추가
	filename := filepath.Join(lfs.logsDir, lfs.currentFile)
	file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("파일 열기 실패: %v", err)
	}
	defer file.Close()

	// JSON 형태로 각 로그를 한 줄씩 저장 (JSONL 형식)
	for _, log := range logs {
		jsonData, err := json.Marshal(log)
		if err != nil {
			continue
		}

		line := string(jsonData) + "\n"
		if _, err := file.WriteString(line); err != nil {
			continue
		}

		lfs.currentSize += int64(len(line))
	}

	// 파일 정보 업데이트
	if fileInfo, exists := lfs.fileIndex[lfs.currentFile]; exists {
		fileInfo.EndLogID = logs[len(logs)-1].ID
		fileInfo.LogCount += len(logs)
		fileInfo.FileSize = lfs.currentSize
		fileInfo.LastModified = time.Now()
	} else {
		// 새 파일 정보 생성
		lfs.fileIndex[lfs.currentFile] = &LogFileInfo{
			Filename:     lfs.currentFile,
			StartLogID:   logs[0].ID,
			EndLogID:     logs[len(logs)-1].ID,
			LogCount:     len(logs),
			FileSize:     lfs.currentSize,
			CreatedAt:    time.Now(),
			LastModified: time.Now(),
		}
	}

	return nil
}

// createNewFile은 새로운 로그 파일을 생성합니다
func (lfs *LogFileStorage) createNewFile() {
	now := time.Now()
	filename := fmt.Sprintf("%s_%03d.log",
		now.Format("20060102"),
		len(lfs.fileIndex)+1)

	lfs.currentFile = filename
	lfs.currentSize = 0

	util.Log(util.ColorCyan, "📁 [FileStorage] 새 로그 파일 생성: %s\n", filename)
}

// addExistingFile은 기존 파일을 인덱스에 추가합니다
func (lfs *LogFileStorage) addExistingFile(filename string, size int64, modTime time.Time) {
	lfs.mutex.Lock()
	defer lfs.mutex.Unlock()

	lfs.fileIndex[filename] = &LogFileInfo{
		Filename:     filename,
		FileSize:     size,
		LastModified: modTime,
		// StartLogID, EndLogID는 실제 파일을 읽어서 결정해야 함
	}
}

// loadLogsFromFile은 특정 파일에서 로그 범위를 로드합니다
func (lfs *LogFileStorage) loadLogsFromFile(filename string, startID, endID int64) ([]LogEntry, error) {
	lfs.mutex.RLock()
	defer lfs.mutex.RUnlock()

	filePath := filepath.Join(lfs.logsDir, filename)
	data, err := ioutil.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("파일 읽기 실패: %v", err)
	}

	// JSONL 형식 파싱
	lines := strings.Split(string(data), "\n")
	logs := make([]LogEntry, 0)

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var log LogEntry
		if err := json.Unmarshal([]byte(line), &log); err != nil {
			continue
		}

		// ID 범위 체크
		if log.ID >= startID && log.ID <= endID {
			logs = append(logs, log)
		}
	}

	return logs, nil
}

// getFileList는 파일 목록을 시간 순으로 정렬해서 반환합니다
func (lfs *LogFileStorage) getFileList() []*LogFileInfo {
	lfs.mutex.RLock()
	defer lfs.mutex.RUnlock()

	files := make([]*LogFileInfo, 0, len(lfs.fileIndex))
	for _, fileInfo := range lfs.fileIndex {
		files = append(files, fileInfo)
	}

	// 생성 시간 순으로 정렬
	sort.Slice(files, func(i, j int) bool {
		return files[i].CreatedAt.Before(files[j].CreatedAt)
	})

	return files
}

// loadLogsInRange는 지정된 ID 범위의 로그들을 파일에서 로드합니다
func (lfs *LogFileStorage) loadLogsInRange(startID, endID int64) ([]LogEntry, error) {
	lfs.mutex.RLock()
	defer lfs.mutex.RUnlock()

	allLogs := make([]LogEntry, 0)

	// 모든 파일을 검사해서 해당 범위에 포함되는 로그 찾기
	for filename := range lfs.fileIndex {
		logs, err := lfs.loadLogsFromFile(filename, startID, endID)
		if err != nil {
			continue // 오류가 있는 파일은 스킵
		}
		allLogs = append(allLogs, logs...)
		if len(logs) > 0 {
			util.Log(util.ColorCyan, "📄 [LogFileStorage] %s에서 %d개 로그 로드\n", filename, len(logs))
		}
	}

	// ID 순으로 정렬
	sort.Slice(allLogs, func(i, j int) bool {
		return allLogs[i].ID < allLogs[j].ID
	})

	util.Log(util.ColorGreen, "📂 [LogFileStorage] 총 %d개 파일에서 %d개 로그 로드 (범위: %d~%d)\n", len(lfs.fileIndex), len(allLogs), startID, endID)
	return allLogs, nil
}

// LogSearchIndex 메서드들

// addLog는 로그를 인덱스에 추가합니다 (파일별 저장)
func (lsi *LogSearchIndex) addLog(log LogEntry, filename string) {
	lsi.mutex.Lock()
	defer lsi.mutex.Unlock()

	fileInfo, exists := lsi.index[filename]
	if !exists {
		lsi.index[filename] = &LogFileInfo{
			Filename:   filename,
			StartLogID: log.ID,
			EndLogID:   log.ID,
			LogCount:   1,
			FileSize:   0,
			CreatedAt:  time.Now(),
		}
	} else {
		if log.ID < fileInfo.StartLogID {
			fileInfo.StartLogID = log.ID
		}
		if log.ID > fileInfo.EndLogID {
			fileInfo.EndLogID = log.ID
		}
		fileInfo.LogCount++
	}
}

// findLogFile은 특정 로그 ID가 포함된 파일을 찾습니다
func (lsi *LogSearchIndex) findLogFile(logID int64) *LogFileInfo {
	lsi.mutex.RLock()
	defer lsi.mutex.RUnlock()

	// 모든 파일을 순회하며 범위에 속하는 파일 찾기
	for _, fileInfo := range lsi.index {
		if logID >= fileInfo.StartLogID && logID <= fileInfo.EndLogID {
			return fileInfo
		}
	}

	return nil
}

// searchByRange는 로그 ID 범위에 해당하는 파일들을 찾습니다
func (lsi *LogSearchIndex) searchByRange(startID, endID int64) []*LogFileInfo {
	lsi.mutex.RLock()
	defer lsi.mutex.RUnlock()

	files := make([]*LogFileInfo, 0)

	// 모든 파일을 순회하며 범위가 겹치는 파일 찾기
	for _, fileInfo := range lsi.index {
		// 파일 범위와 검색 범위가 겹치는지 확인
		if fileInfo.EndLogID >= startID && fileInfo.StartLogID <= endID {
			files = append(files, fileInfo)
		}
	}

	return files
}

// save는 인덱스를 파일에 저장합니다
func (lsi *LogSearchIndex) save() error {
	lsi.mutex.RLock()
	defer lsi.mutex.RUnlock()

	data, err := json.MarshalIndent(lsi.index, "", "  ")
	if err != nil {
		return fmt.Errorf("인덱스 직렬화 실패: %v", err)
	}

	return ioutil.WriteFile(lsi.indexFile, data, 0644)
}

// load는 파일에서 인덱스를 로드합니다
func (lsi *LogSearchIndex) load() error {
	lsi.mutex.Lock()
	defer lsi.mutex.Unlock()

	if _, err := os.Stat(lsi.indexFile); os.IsNotExist(err) {
		// 인덱스 파일이 없으면 빈 인덱스로 시작
		lsi.index = make(map[string]*LogFileInfo)
		return nil
	}

	data, err := ioutil.ReadFile(lsi.indexFile)
	if err != nil {
		return fmt.Errorf("인덱스 파일 읽기 실패: %v", err)
	}

	return json.Unmarshal(data, &lsi.index)
}

// FileOnly LogBuffer 구현 (향후 확장용)

// FileLogBuffer는 파일 중심의 로그 버퍼입니다 (초대용량 처리용)
type FileLogBuffer struct {
	config      LogBufferConfig
	fileStorage *LogFileStorage
	searchIndex *LogSearchIndex
	// 최소한의 메모리 버퍼만 유지
	recentLogs []LogEntry
	mutex      sync.RWMutex
}

// NewFileLogBuffer는 파일 전용 로그 버퍼를 생성합니다
func NewFileLogBuffer(config LogBufferConfig) *FileLogBuffer {
	// TODO: 파일 전용 버퍼 구현 (향후 확장)
	util.Log(util.ColorYellow, "⚠️ [FileLogBuffer] 아직 구현되지 않음 - HybridLogBuffer 사용 권장\n")
	return nil
}
