package util

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// LocalFileResourceManager: 로컬 파일 리소스들의 생성과 자동 정리를 관리
type LocalFileResourceManager struct {
	tempFiles []string // 생성된 임시 파일 경로들
	baseDir   string   // 기본 디렉토리
}

// NewLocalFileResourceManager: 새로운 LocalFileResourceManager 인스턴스 생성
func NewLocalFileResourceManager() *LocalFileResourceManager {
	return &LocalFileResourceManager{
		tempFiles: make([]string, 0),
		baseDir:   os.TempDir(),
	}
}

// CreateTempFile: 임시 파일 생성 및 추적
func (frm *LocalFileResourceManager) CreateTempFile(prefix, suffix string) (string, error) {
	fileName := fmt.Sprintf("%s_%d%s", prefix, time.Now().Unix(), suffix)
	filePath := filepath.Join(frm.baseDir, fileName)

	if err := os.MkdirAll(frm.baseDir, 0755); err != nil {
		return "", err
	}

	frm.tempFiles = append(frm.tempFiles, filePath)
	return filePath, nil
}

// AddExistingFile: 이미 생성된 파일을 추적 목록에 추가
func (frm *LocalFileResourceManager) AddExistingFile(filePath string) {
	frm.tempFiles = append(frm.tempFiles, filePath)
}

// Cleanup: 모든 임시 파일 삭제 및 빈 폴더 정리
func (frm *LocalFileResourceManager) Cleanup() {
	for _, filePath := range frm.tempFiles {
		if err := os.Remove(filePath); err != nil {
			Log(ColorYellow, "임시 파일 삭제 실패: %s (%v)\n", filePath, err)
		} else {
			Log(ColorGreen, "임시 파일 삭제 완료: %s\n", filePath)
			// 빈 부모 폴더 정리
			frm.cleanupEmptyLocalParentDirs(filePath)
		}
	}
	frm.tempFiles = nil
}

// cleanupEmptyLocalParentDirs: 로컬 파일 삭제 후 빈 부모 디렉터리를 재귀적으로 정리
func (frm *LocalFileResourceManager) cleanupEmptyLocalParentDirs(filePath string) {
	dir := filepath.Dir(filePath)
	for dir != "." && dir != "/" && dir != frm.baseDir {
		entries, err := os.ReadDir(dir)
		if err != nil {
			Log(ColorYellow, "디렉터리 읽기 실패: %s (%v)\n", dir, err)
			break
		}
		if len(entries) == 0 {
			if err := os.Remove(dir); err != nil {
				Log(ColorYellow, "빈 디렉터리 삭제 실패: %s (%v)\n", dir, err)
				break
			} else {
				Log(ColorGreen, "빈 디렉터리 삭제 완료: %s\n", dir)
			}
		} else {
			break // 디렉터리가 비어있지 않으면 중단
		}
		dir = filepath.Dir(dir)
	}
}

// ProcessResourceManager: 실행된 shell 프로세스들의 추적과 자동 정리를 관리
type ProcessResourceManager struct {
	processIDs []int  // 실행된 프로세스 ID들
}

// NewProcessResourceManager: 새로운 ProcessResourceManager 인스턴스 생성
func NewProcessResourceManager() *ProcessResourceManager {
	return &ProcessResourceManager{
		processIDs: make([]int, 0),
	}
}

// AddProcess: 프로세스 ID를 추적 목록에 추가
func (prm *ProcessResourceManager) AddProcess(pid int) {
	prm.processIDs = append(prm.processIDs, pid)
}

// Cleanup: 모든 shell 프로세스 강제 종료
func (prm *ProcessResourceManager) Cleanup() {
	for _, pid := range prm.processIDs {
		// 1. 먼저 특정 PID의 프로세스 종료 시도
		cmd := exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/T", "/F")
		if err := cmd.Run(); err != nil {
			// PowerShell 프로세스가 이미 종료된 경우는 정상
			if strings.Contains(err.Error(), "not found") ||
				strings.Contains(err.Error(), "128") ||
				strings.Contains(err.Error(), "process") {
				Log(ColorBlue, "PowerShell 프로세스 이미 종료됨 (PID: %d)\n", pid)
			} else {
				Log(ColorYellow, "프로세스 종료 실패 (PID: %d): %v\n", pid, err)
			}
		} else {
			Log(ColorGreen, "프로세스 종료 완료 (PID: %d)\n", pid)
		}

		// 2. CMD 창들이 남아있을 수 있으므로 cmd.exe 프로세스들도 정리
		// (주의: 이건 과감한 방법으로, 모든 CMD 창이 종료될 수 있음)
		// 필요시 더 정교한 방법으로 개선 가능
	}

	// CMD 프로세스 정리 (선택적)
	// cmdCleanup := exec.Command("taskkill", "/IM", "cmd.exe", "/F")
	// if err := cmdCleanup.Run(); err == nil {
	//     Log(ColorGreen, "모든 CMD 창 정리 완료\n")
	// }

	prm.processIDs = nil
}
