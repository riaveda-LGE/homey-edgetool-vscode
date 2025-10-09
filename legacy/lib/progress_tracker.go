package lib

import (
	"strings"
	"time"

	"edgetool/util"
)

// ProgressTracker는 작업 진행 상황을 실시간으로 표시하는 컴포넌트입니다
type ProgressTracker struct {
	message string
	start   time.Time
	done    chan bool
	ticker  *time.Ticker
}

// NewProgressTracker는 새로운 ProgressTracker 인스턴스를 생성합니다
func NewProgressTracker(message string) *ProgressTracker {
	return &ProgressTracker{
		message: message,
		done:    make(chan bool, 1),
	}
}

// Start는 진행 표시를 시작합니다
func (p *ProgressTracker) Start() {
	p.start = time.Now()
	p.ticker = time.NewTicker(1 * time.Second)

	go func() {
		defer p.ticker.Stop()
		for {
			select {
			case <-p.done:
				return
			case <-p.ticker.C:
				elapsed := time.Since(p.start)
				util.Log("\r%s 진행 중... (%.1fs)", p.message, elapsed.Seconds())
			}
		}
	}()
}

// Finish는 진행 표시를 종료하고 화면을 정리합니다
func (p *ProgressTracker) Finish() {
	if p.ticker != nil {
		p.done <- true
		p.ticker.Stop()
		// 진행 표시 라인 지우기
		util.Log("\r" + strings.Repeat(" ", 60) + "\r")
	}
}

// GetElapsedTime은 경과 시간을 반환합니다
func (p *ProgressTracker) GetElapsedTime() time.Duration {
	return time.Since(p.start)
}
