package lib

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	logviewer "edgetool/lib/log-viewer"
	"edgetool/util"
)

// LoggingHandler는 로깅을 담당하는 핸들러입니다
type LoggingHandler struct{}

// NewLoggingHandler는 새로운 로깅 핸들러를 생성합니다
func NewLoggingHandler() *LoggingHandler {
	return &LoggingHandler{}
}

// HandleLogViewer는 로그 뷰어 명령을 처리하며 로깅을 포함합니다
func (lh *LoggingHandler) HandleLogViewer(directory string) error {
	util.Log(util.ColorGreen, "🚀 로그 뷰어 모드 시작\n")

	err := lh.startLogViewerWithLocalFiles(directory)

	util.Log(util.ColorGreen, "✅ 로그 뷰어 모드 종료\n")
	return err
}

// startLogViewerWithLocalFiles는 로컬 파일 통합 모드로 로그 뷰어를 시작합니다
func (lh *LoggingHandler) startLogViewerWithLocalFiles(directory string) error {
	util.Log(util.ColorGreen, "🚀 로컬 파일 통합 로그 뷰어 시작: %s\n", directory)

	// 디렉토리 존재 확인
	if _, err := os.Stat(directory); os.IsNotExist(err) {
		return fmt.Errorf("디렉토리를 찾을 수 없습니다: %s", directory)
	}

	// 시그널 채널 생성 (SIGINT: Ctrl+C, SIGTERM: kill 명령)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)

	// 취소 가능한 context 생성
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 시그널 핸들링 고루틴
	go func() {
		<-quit
		util.Log(util.ColorYellow, "🛑 종료 시그널 수신됨, 서버를 정상적으로 종료합니다...\n")
		cancel() // context 취소
	}()

	// 1단계: 빈 버퍼로 웹 서버 먼저 시작
	// 프로젝트 루트 찾기 (go.mod가 있는 디렉토리)
	projectRoot, err := lh.findProjectRoot()
	if err != nil {
		util.Log(util.ColorRed, "프로젝트 루트 찾기 실패: %v\n", err)
		return err
	}

	// logs 디렉토리 생성 (프로젝트 루트에)
	logsDir := filepath.Join(projectRoot, "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		util.Log(util.ColorRed, "logs 디렉토리 생성 실패: %v\n", err)
		return err
	}

	emptyBuffer := logviewer.NewHybridLogBuffer(logviewer.LogBufferConfig{
		Type:           logviewer.BufferTypeHybrid,
		MaxMemorySize:  1000,
		ViewportSize:   500,
		LogsDirectory:  logsDir, // ✅ logs 디렉토리 지정
		EnableIndexing: true,
	})
	config := logviewer.LogViewerConfig{
		Port:        logviewer.DEFAULT_WEB_SERVER_PORT,
		Host:        "localhost",
		LocalBuffer: emptyBuffer,
		Mode:        "local-files",
	}

	viewer := logviewer.NewLogViewer(config)

	// 웹 서버를 백그라운드에서 시작
	go func() {
		viewer.Start()
	}()

	// 2단계: 웹 서버 시작 대기 (3초)
	util.Log(util.ColorCyan, "🌐 웹 서버 시작 대기 중...\n")
	time.Sleep(3 * time.Second)

	// 3단계: 로그 파일 통합 엔진 생성 및 병합 시작
	integration := logviewer.NewLogFileIntegration(logsDir)

	// 통합 엔진의 버퍼를 웹 뷰어의 버퍼로 교체
	integration.SetMainBuffer(emptyBuffer)

	// 로그 파일 로드 및 통합 (실시간으로 웹에 표시됨) - context로 취소 가능
	err = integration.LoadLogsFromDirectoryWithContext(ctx, directory)
	if err != nil {
		if ctx.Err() == context.Canceled {
			util.Log(util.ColorYellow, "📊 로그 로딩이 취소되었습니다\n")
		} else {
			return fmt.Errorf("로그 파일 통합 실패: %v", err)
		}
	} else {
		// 실시간 전송이 이미 완료되었으므로 배치 전송 생략
		// (중복 방지: 이미 실시간으로 4264개 전송됨)
		util.Log(util.ColorCyan, "📊 실시간 전송 완료 - 배치 전송 생략\n")

		util.Log(util.ColorGreen, "✅ 로그 통합 완료! 웹 브라우저에서 확인하세요.\n")
	}

	util.Log(util.ColorYellow, "💡 종료하려면 Ctrl+C를 누르세요.\n")

	// context 취소 대기 (시그널 핸들링 고루틴이 cancel() 호출)
	<-ctx.Done()

	// 서버 정리 (필요한 경우)
	util.Log(util.ColorGreen, "✅ 서버가 정상적으로 종료되었습니다\n")

	return nil
}

// findProjectRoot는 go.mod 파일이 있는 프로젝트 루트 디렉토리를 찾습니다
func (lh *LoggingHandler) findProjectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break // 루트까지 갔음
		}
		dir = parent
	}

	return "", fmt.Errorf("go.mod 파일을 찾을 수 없음")
}

// 다른 핸들러들도 비슷하게 추가 가능 (예: HandleGit, HandleHomey 등)
