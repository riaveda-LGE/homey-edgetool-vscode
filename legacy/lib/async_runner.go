package lib

import (
	"time"
)

// AsyncResult는 비동기 작업의 결과를 담는 구조체입니다
type AsyncResult struct {
	Error    error
	Duration time.Duration
	Data     interface{}
}

// RunAsyncWithProgress는 작업을 비동기로 실행하고 진행 상황을 표시합니다
func RunAsyncWithProgress(task func() (interface{}, error), message string) <-chan AsyncResult {
	resultChan := make(chan AsyncResult, 1)

	// 진행 표시 시작
	progress := NewProgressTracker(message)
	progress.Start()

	// 비동기 작업 실행
	go func() {
		defer progress.Finish() // 작업 완료 후 진행 표시 종료

		start := time.Now()

		// 작업 실행
		data, err := task()
		duration := time.Since(start)

		resultChan <- AsyncResult{
			Error:    err,
			Duration: duration,
			Data:     data,
		}
	}()

	return resultChan
}

// RunWithProgress는 에러만 반환하는 작업을 비동기로 실행하고 진행 상황을 표시합니다
func RunWithProgress(task func() error, message string) error {
	resultChan := RunAsyncWithProgress(
		func() (interface{}, error) { return nil, task() },
		message,
	)

	// 결과를 기다렸다가 에러만 반환
	result := <-resultChan
	return result.Error
}
