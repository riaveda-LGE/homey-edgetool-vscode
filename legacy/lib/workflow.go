package lib

import (
	"fmt"
	"time"

	"edgetool/util"
)

// WorkflowEngine은 상태 기반 워크플로우를 실행하는 엔진입니다
type WorkflowEngine struct {
	steps map[string]*WorkflowStep
}

// WorkflowStep은 워크플로우의 각 단계를 나타냅니다
type WorkflowStep struct {
	Name     string
	Execute  func(ctx *WorkflowContext) (*StepResult, error)
	NextStep func(result *StepResult) string
	Timeout  time.Duration
}

// StepResult는 각 단계의 실행 결과를 나타냅니다
type StepResult struct {
	Success bool
	Data    interface{}
}

// WorkflowContext는 워크플로우 실행 컨텍스트입니다
type WorkflowContext struct {
	CM     *ConnectionManager
	State  map[string]interface{}
	Logger func(color string, format string, args ...interface{})
}

// NewWorkflowEngine은 새로운 워크플로우 엔진을 생성합니다
func NewWorkflowEngine(steps map[string]*WorkflowStep) *WorkflowEngine {
	return &WorkflowEngine{
		steps: steps,
	}
}

// Execute는 워크플로우를 실행합니다
func (we *WorkflowEngine) Execute(startStep string, ctx *WorkflowContext) error {
	currentStep := startStep
	maxIterations := 50 // 무한루프 방지
	iteration := 0
	
	// 총 단계 수 계산 (진행률 표시용)
	totalSteps := we.calculateTotalSteps(startStep)
	
	for currentStep != "" && iteration < maxIterations {
		iteration++
		
		step, exists := we.steps[currentStep]
		if !exists {
			return fmt.Errorf("unknown step: %s", currentStep)
		}
		
		// 진행률 표시 개선
		progress := fmt.Sprintf("[%d/%d]", iteration, totalSteps)
		ctx.Logger(util.ColorBrightCyan, "\n%s 단계 실행: %s\n", progress, step.Name)
		
		// 타임아웃과 함께 실행
		result, err := we.executeWithTimeout(step, ctx)
		if err != nil {
			ctx.Logger(util.ColorRed, "단계 실행 실패: %v\n", err)
			return err
		}
		
		if !result.Success {
			ctx.Logger(util.ColorRed, "단계 실행 결과 실패\n")
			return fmt.Errorf("step failed: %s", step.Name)
		}
		
		// 다음 단계 결정
		nextStep := step.NextStep(result)
		if nextStep != "" {
			ctx.Logger(util.ColorGray, "다음 단계: %s\n", nextStep)
		}
		
		currentStep = nextStep
		
		// 단계 간 짧은 대기
		if currentStep != "" {
			time.Sleep(500 * time.Millisecond)
		}
	}
	
	if iteration >= maxIterations {
		return fmt.Errorf("workflow exceeded maximum iterations: %d", maxIterations)
	}
	
	ctx.Logger(util.ColorBrightGreen, "\n✅ 워크플로우 완료! (총 %d단계)\n", iteration)
	return nil
}

// calculateTotalSteps는 워크플로우의 예상 총 단계 수를 계산합니다
func (we *WorkflowEngine) calculateTotalSteps(startStep string) int {
	visited := make(map[string]bool)
	
	var countSteps func(step string) int
	countSteps = func(step string) int {
		if visited[step] {
			return 0 // 순환 참조 방지
		}
		visited[step] = true
		
		workflowStep, exists := we.steps[step]
		if !exists {
			return 0
		}
		
		count := 1 // 현재 단계
		
		// 가능한 모든 다음 단계를 고려 (단순화된 추정)
		// 실제로는 모든 조건부 경로를 계산하기 복잡하므로
		// 기본적인 단계 수만 계산
		if workflowStep.NextStep != nil {
			// 일반적인 경우의 다음 단계들 고려
			possibleNext := []string{
				"check_running_containers",
				"stop_containers", 
				"check_stopped_containers",
				"remove_containers",
				"remove_volumes",
				"check_remaining_volumes",
				"update_service_file",
			}
			
			for _, next := range possibleNext {
				if _, exists := we.steps[next]; exists {
					count += countSteps(next)
					break // 첫 번째 유효한 다음 단계만 계산
				}
			}
		}
		
		return count
	}
	
	return countSteps(startStep)
}

// executeWithTimeout은 타임아웃과 함께 단계를 실행합니다
func (we *WorkflowEngine) executeWithTimeout(step *WorkflowStep, ctx *WorkflowContext) (*StepResult, error) {
	resultChan := make(chan *StepResult, 1)
	errorChan := make(chan error, 1)
	
	go func() {
		result, err := step.Execute(ctx)
		if err != nil {
			errorChan <- err
		} else {
			resultChan <- result
		}
	}()
	
	// 간단한 타임아웃 구현
	timeout := time.After(step.Timeout)
	
	select {
	case result := <-resultChan:
		return result, nil
	case err := <-errorChan:
		return nil, err
	case <-timeout:
		return nil, fmt.Errorf("step timeout after %v", step.Timeout)
	}
}
