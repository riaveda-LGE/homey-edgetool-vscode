package lib

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	logviewer "edgetool/lib/log-viewer"
	"edgetool/util"
)

// HomeyHandler는 Homey 관련 명령어를 처리합니다
type HomeyHandler struct {
	BaseHandler
	serviceNameCache string // 서비스 이름 캐시
}

// NewHomeyHandler는 새로운 HomeyHandler 인스턴스를 생성합니다
func NewHomeyHandler() *HomeyHandler {
	return &HomeyHandler{
		serviceNameCache: "",
	}
}

// Cleanup은 HomeyHandler의 리소스를 정리합니다
func (h *HomeyHandler) Cleanup() {
	// 서비스 이름 캐시 초기화
	h.serviceNameCache = ""
	util.Log(util.ColorCyan, "HomeyHandler 리소스 정리 완료\n")
}

func (h *HomeyHandler) Execute(cm *ConnectionManager, args string) error {
	// 연결 상태 확인
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return fmt.Errorf("연결이 설정되어 있지 않거나 연결되어 있지 않습니다. 먼저 연결을 설정하세요")
	}

	args = strings.TrimSpace(args)
	parts := strings.Fields(args)

	if len(parts) == 0 {
		return fmt.Errorf("homey 명령이 필요합니다")
	}

	switch parts[0] {
	case "restart":
		return h.Restart(cm)
	case "unmount":
		return h.Unmount(cm)
	case "mount":
		if len(parts) < 2 {
			return fmt.Errorf("mount 옵션이 필요합니다: --list, pro, core, sdk, bridge")
		}
		return h.Mount(cm, parts[1])
	case "logging":
		// logging 또는 logging <filter>
		var filter string
		if len(parts) > 1 {
			filter = parts[1]
		}
		_, err := h.Logging(cm, filter)
		return err
	default:
		return fmt.Errorf("unknown homey command: %s", parts[0])
	}
}

func (h *HomeyHandler) Restart(cm *ConnectionManager) error {
	// SSH 연결 시 homey 설치 여부 확인
	if _, ok := cm.currentConnection.(*SSHConnection); ok {
		_, err := h.GetHomeyServiceName(cm)
		if err != nil {
			return fmt.Errorf("SSH 디바이스에 homey가 설치되어 있지 않아 테스트를 건너뜁니다")
		}
	}

	util.Log(util.ColorCyan, "Homey 서비스를 재시작합니다...\n")

	// 서비스 이름 찾기
	serviceName, err := h.GetHomeyServiceName(cm)
	if err != nil {
		return fmt.Errorf("homey 서비스 이름을 찾을 수 없습니다: %v", err)
	}

	// systemctl restart <serviceName>
	output, err := ExcuteOnShell(cm, fmt.Sprintf("systemctl restart %s", serviceName))
	if err != nil {
		return fmt.Errorf("homey 서비스 재시작 실패: %v", err)
	}

	if output != "" {
		util.Log("%s", output)
	}

	util.Log(util.ColorGreen, "Homey 서비스 재시작 완료: %s\n", serviceName)
	return nil
}

func (h *HomeyHandler) Mount(cm *ConnectionManager, option string) error {
	// SSH 연결 시 homey 설치 여부 확인
	if _, ok := cm.currentConnection.(*SSHConnection); ok {
		_, err := h.GetHomeyServiceName(cm)
		if err != nil {
			return fmt.Errorf("SSH 디바이스에 homey가 설치되어 있지 않아 테스트를 건너뜁니다")
		}
	}

	switch option {
	case "--list":
		util.Log(util.ColorCyan, "현재 마운트된 볼륨 목록:\n")

		// --list 옵션은 단순히 Docker 볼륨 목록만 보여주면 됨 (mount -o remount 불필요)
		output, err := ExcuteOnShell(cm, "docker volume ls")
		if err != nil {
			util.Log(util.ColorRed, "볼륨 목록 조회 실패: %v\n", err)
			util.Log(util.ColorYellow, "Docker 서비스가 실행 중인지 확인해보세요.\n")
			return fmt.Errorf("볼륨 목록 조회 실패: %v", err)
		}
		if strings.TrimSpace(output) == "" {
			util.Log(util.ColorYellow, "마운트된 볼륨이 없습니다.\n")
		} else {
			util.Log("%s", output)
		}
		return nil

	case "pro", "core", "sdk", "bridge":
		// mount 옵션들만 파일시스템을 rw 모드로 마운트
		util.Log(util.ColorCyan, "Homey 마운트를 시작합니다...\n")

		// 파일시스템을 읽기/쓰기 모드로 마운트
		_, err := ExcuteOnShell(cm, "mount -o remount,rw /")
		if err != nil {
			return fmt.Errorf("파일시스템 마운트 실패: %v", err)
		}

		// 각 옵션에 따른 볼륨 마운트
		switch option {
		case "pro":
			return h.mountVolume(cm, "homey-app", "/app/")
		case "core", "sdk", "bridge":
			return h.mountVolume(cm, "homey-node", "/node_modules/")
		}

	default:
		return fmt.Errorf("잘못된 mount 옵션: %s (사용 가능: --list, pro, core, sdk, bridge)", option)
	}

	return nil
}

func (h *HomeyHandler) mountVolume(cm *ConnectionManager, volumeName string, mountPath string) error {
	// 현재 서비스 파일 내용을 확인
	output, err := ExcuteOnShell(cm, "cat /lib/systemd/system/homey-pro@.service")
	if err != nil {
		return fmt.Errorf("서비스 파일 읽기 실패: %v", err)
	}

	// 이미 마운트되어 있는지 확인
	if strings.Contains(output, volumeName) {
		util.Log(util.ColorYellow, "볼륨 %s이(가) 이미 마운트되어 있습니다.\n", volumeName)
		return nil
	}
	// 서비스 종료전에 이름을 cache에 저장
	_, err = h.GetHomeyServiceName(cm)
	if err != nil {
		return fmt.Errorf("homey 서비스 이름을 찾을 수 없습니다: %v", err)
	}

	// 볼륨 마운트 라인 추가
	util.Log(util.ColorCyan, "sed 스크립트를 사용하여 볼륨 마운트 라인을 추가합니다...\n")

	// Create sed script content - insert after ExecStart line
	newVolume := fmt.Sprintf("  --volume=\"%s:%s:rw\" \\\\", volumeName, mountPath)
	sedScript := fmt.Sprintf("/^ExecStart=/a\\\n%s", newVolume)

	util.Log(util.ColorCyan, "생성할 sed 스크립트 내용:\n%s\n", sedScript)

	// Execute sed script using generic script execution function
	scriptName := fmt.Sprintf("mount_%s", volumeName)
	targetFile := "/lib/systemd/system/homey-pro@.service"
	err = CreateAndExecuteScript(cm, "sed", scriptName, sedScript, targetFile)
	if err != nil {
		return fmt.Errorf("볼륨 마운트 라인 추가 실패: %v", err)
	}

	// systemd 데몬 리로드
	_, err = ExcuteOnShell(cm, "systemctl daemon-reload")
	if err != nil {
		return fmt.Errorf("systemd 데몬 리로드 실패: %v", err)
	}

	util.Log(util.ColorGreen, "볼륨 %s이(가) %s에 성공적으로 마운트되었습니다.\n", volumeName, mountPath)
	// 자동으로 재시작 실행
	err = h.Restart(cm)
	if err != nil {
		return fmt.Errorf("재시작 실패: %v", err)
	}

	return nil
}

func (h *HomeyHandler) Unmount(cm *ConnectionManager) error {
	// SSH 연결 시 homey 설치 여부 확인
	if _, ok := cm.currentConnection.(*SSHConnection); ok {
		_, err := h.GetHomeyServiceName(cm)
		if err != nil {
			return fmt.Errorf("SSH 디바이스에 homey가 설치되어 있지 않아 테스트를 건너뜁니다")
		}
	}

	util.Log(util.ColorYellow, "🚨 Homey 언마운트를 시작합니다...\n")
	util.Log(util.ColorYellow, "이 작업은 시간이 오래 걸릴 수 있습니다.\n")

	// 서비스 이름 찾기
	_, err := h.GetHomeyServiceName(cm)
	if err != nil {
		return fmt.Errorf("homey 서비스 이름을 찾을 수 없습니다: %v", err)
	}

	workflow := h.createUnmountWorkflow()
	ctx := &WorkflowContext{
		CM:    cm,
		State: make(map[string]interface{}),
		Logger: func(color string, format string, args ...interface{}) {
			if color == "" {
				logArgs := make([]interface{}, 0, len(args)+1)
				logArgs = append(logArgs, format)
				logArgs = append(logArgs, args...)
				util.Log(logArgs...)
			} else {
				logArgs := make([]interface{}, 0, len(args)+2)
				logArgs = append(logArgs, color, format)
				logArgs = append(logArgs, args...)
				util.Log(logArgs...)
			}
		},
	}

	err = workflow.Execute("check_mounted_volumes", ctx)
	if err != nil {
		return fmt.Errorf("❌ 언마운트 실패: %v", err)
	}

	util.Log(util.ColorBrightGreen, "✅ 언마운트 완료!\n")
	return nil
}

// Homey unmount 워크플로우 구현 함수들

func (h *HomeyHandler) checkMountedVolumes(ctx *WorkflowContext) (*StepResult, error) {
	ctx.Logger(util.ColorCyan, "마운트된 볼륨을 확인합니다...\n")

	out, err := ExcuteOnShell(ctx.CM, "docker volume ls --format '{{.Name}}'")
	if err != nil {
		return &StepResult{Success: false}, err
	}

	volumes := strings.Fields(strings.TrimSpace(out))
	ctx.State["mounted_volumes"] = volumes

	if len(volumes) > 0 {
		ctx.Logger(util.ColorYellow, "마운트된 볼륨 %d개 발견\n", len(volumes))
		for _, v := range volumes {
			ctx.Logger("", "  - %s\n", v)
		}
	} else {
		ctx.Logger(util.ColorGreen, "마운트된 볼륨이 없습니다.\n")
	}

	return &StepResult{
		Success: true,
		Data:    volumes,
	}, nil
}

func (h *HomeyHandler) checkRunningContainers(ctx *WorkflowContext) (*StepResult, error) {
	ctx.Logger(util.ColorCyan, "실행중인 컨테이너를 확인합니다...\n")

	out, err := ExcuteOnShell(ctx.CM, "docker ps --format '{{.ID}}'")
	if err != nil {
		return &StepResult{Success: false}, err
	}

	containers := strings.Fields(strings.TrimSpace(out))
	ctx.State["running_containers"] = containers

	if len(containers) > 0 {
		ctx.Logger(util.ColorYellow, "실행중인 컨테이너 %d개 발견\n", len(containers))
		for _, c := range containers {
			ctx.Logger("", "  - %s\n", c)
		}
	} else {
		ctx.Logger(util.ColorGreen, "실행중인 컨테이너가 없습니다.\n")
	}

	return &StepResult{
		Success: true,
		Data:    containers,
	}, nil
}

func (h *HomeyHandler) stopContainers(ctx *WorkflowContext) (*StepResult, error) {
	containers := ctx.State["running_containers"].([]string)

	for _, containerID := range containers {
		ctx.Logger(util.ColorYellow, "docker %s 정지 중... 시간이 오래 걸릴 수 있습니다.\n", containerID)

		// 재시도 로직 추가 (최대 3회)
		maxRetries := 3
		success := false

		for retry := 0; retry < maxRetries; retry++ {
			if retry > 0 {
				ctx.Logger(util.ColorYellow, "재시도 %d/%d...\n", retry+1, maxRetries)
				time.Sleep(2 * time.Second)
			}

			_, err := ExcuteOnShell(ctx.CM, fmt.Sprintf("docker stop %s", containerID))
			if err == nil {
				ctx.Logger(util.ColorGreen, "docker %s 정지 성공\n", containerID)
				success = true
				break
			} else {
				ctx.Logger(util.ColorRed, "docker %s 정지 실패 (시도 %d/%d): %v\n", containerID, retry+1, maxRetries, err)
			}
		}

		if !success {
			ctx.Logger(util.ColorRed, "docker %s 정지 최종 실패 - 계속 진행합니다.\n", containerID)
		}

		// 각 컨테이너 정지 후 잠시 대기
		time.Sleep(1 * time.Second)
	}

	return &StepResult{Success: true}, nil
}

func (h *HomeyHandler) checkStoppedContainers(ctx *WorkflowContext) (*StepResult, error) {
	ctx.Logger(util.ColorCyan, "정지된 컨테이너를 확인합니다...\n")

	out, err := ExcuteOnShell(ctx.CM, "docker ps -a --format '{{.ID}}'")
	if err != nil {
		return &StepResult{Success: false}, err
	}

	containers := strings.Fields(strings.TrimSpace(out))
	ctx.State["stopped_containers"] = containers

	if len(containers) > 0 {
		ctx.Logger(util.ColorYellow, "정지된 컨테이너 %d개 발견\n", len(containers))
		for _, c := range containers {
			ctx.Logger("", "  - %s\n", c)
		}
	} else {
		ctx.Logger(util.ColorGreen, "정지된 컨테이너가 없습니다.\n")
	}

	return &StepResult{
		Success: true,
		Data:    containers,
	}, nil
}

func (h *HomeyHandler) removeContainers(ctx *WorkflowContext) (*StepResult, error) {
	containers := ctx.State["stopped_containers"].([]string)

	for _, containerID := range containers {
		ctx.Logger(util.ColorYellow, "docker %s 제거 중... 시간이 오래 걸릴 수 있습니다.\n", containerID)

		_, err := ExcuteOnShell(ctx.CM, fmt.Sprintf("docker rm -f %s", containerID))
		if err != nil {
			ctx.Logger(util.ColorRed, "컨테이너 %s 제거 실패: %v\n", containerID, err)
			// 실패해도 계속 진행
		} else {
			ctx.Logger(util.ColorGreen, "docker %s 제거 요청됨\n", containerID)
		}

		time.Sleep(1 * time.Second)
	}

	return &StepResult{Success: true}, nil
}

func (h *HomeyHandler) removeVolumes(ctx *WorkflowContext) (*StepResult, error) {
	ctx.Logger(util.ColorCyan, "볼륨을 제거합니다...\n")

	volumes := []string{"homey-app", "homey-node"}

	for _, volume := range volumes {
		ctx.Logger(util.ColorYellow, "볼륨 %s 제거 중...\n", volume)

		_, err := ExcuteOnShell(ctx.CM, fmt.Sprintf("docker volume remove %s", volume))
		if err != nil {
			ctx.Logger(util.ColorRed, "볼륨 %s 제거 실패: %v\n", volume, err)
			// 실패해도 계속 진행
		} else {
			ctx.Logger(util.ColorGreen, "볼륨 %s 제거됨\n", volume)
		}
	}

	return &StepResult{Success: true}, nil
}

func (h *HomeyHandler) checkRemainingVolumes(ctx *WorkflowContext) (*StepResult, error) {
	ctx.Logger(util.ColorCyan, "남은 볼륨을 확인합니다...\n")

	out, err := ExcuteOnShell(ctx.CM, "docker volume ls --format '{{.Name}}'")
	if err != nil {
		return &StepResult{Success: false}, err
	}

	volumes := strings.Fields(strings.TrimSpace(out))

	if len(volumes) > 0 {
		ctx.Logger(util.ColorYellow, "남은 볼륨 %d개:\n", len(volumes))
		for _, v := range volumes {
			ctx.Logger("", "  - %s\n", v)
		}
	} else {
		ctx.Logger(util.ColorGreen, "모든 볼륨이 제거되었습니다.\n")
	}

	return &StepResult{
		Success: true,
		Data:    volumes,
	}, nil
}

func (h *HomeyHandler) updateServiceFile(ctx *WorkflowContext) (*StepResult, error) {
	ctx.Logger(util.ColorCyan, "서비스 파일을 업데이트합니다...\n")

	// 파일시스템을 읽기/쓰기 모드로 마운트
	_, err := ExcuteOnShell(ctx.CM, "mount -o remount,rw /")
	if err != nil {
		return &StepResult{Success: false}, fmt.Errorf("파일시스템 마운트 실패: %v", err)
	}

	// sed 스크립트 생성 - 볼륨 관련 라인 제거
	sedScript := "/homey-app/d\n/homey-node/d"

	util.Log(util.ColorCyan, "생성할 sed 스크립트 내용:\n%s\n", sedScript)

	// CreateAndExecuteScript를 사용하여 sed 스크립트 실행
	scriptName := "remove_volumes"
	targetFile := "/lib/systemd/system/homey-pro@.service"
	err = CreateAndExecuteScript(ctx.CM, "sed", scriptName, sedScript, targetFile)
	if err != nil {
		return &StepResult{Success: false}, fmt.Errorf("볼륨 라인 제거 실패: %v", err)
	}

	ctx.Logger(util.ColorGreen, "볼륨 관련 라인 제거 완료\n")

	// systemd 데몬 리로드
	_, err = ExcuteOnShell(ctx.CM, "systemctl daemon-reload")
	if err != nil {
		return &StepResult{Success: false}, fmt.Errorf("systemd 데몬 리로드 실패: %v", err)
	}

	ctx.Logger(util.ColorGreen, "서비스 파일 업데이트 완료\n")
	return &StepResult{Success: true}, nil
}

func (h *HomeyHandler) restartServiceStep(ctx *WorkflowContext) (*StepResult, error) {
	ctx.Logger(util.ColorCyan, "Homey 서비스를 재시작합니다...\n")

	// restart 함수 호출
	err := h.Restart(ctx.CM)
	if err != nil {
		return &StepResult{Success: false}, fmt.Errorf("재시작 실패: %v", err)
	}

	ctx.Logger(util.ColorGreen, "재시작 완료!\n")

	return &StepResult{Success: true}, nil
}

// createUnmountWorkflow는 Homey unmount 워크플로우를 생성합니다
func (h *HomeyHandler) createUnmountWorkflow() *WorkflowEngine {
	return NewWorkflowEngine(map[string]*WorkflowStep{
		"check_mounted_volumes": {
			Name:    "마운트된 볼륨 확인",
			Execute: h.checkMountedVolumes,
			NextStep: func(result *StepResult) string {
				volumes := result.Data.([]string)
				if len(volumes) == 0 {
					// 마운트된 볼륨이 없으면 워크플로우 종료
					util.Log(util.ColorYellow, "⚠️  마운트된 볼륨이 없습니다. 언마운트 작업을 건너뜁니다.\n")
					return "" // 빈 문자열 반환으로 워크플로우 종료
				}
				// 마운트된 볼륨이 있으면 다음 단계로 진행
				return "check_running_containers"
			},
			Timeout: 10 * time.Second,
		},
		"check_running_containers": {
			Name:    "실행중인 컨테이너 확인",
			Execute: h.checkRunningContainers,
			NextStep: func(result *StepResult) string {
				containers := result.Data.([]string)
				if len(containers) > 0 {
					return "stop_containers"
				}
				return "check_stopped_containers"
			},
			Timeout: 10 * time.Second,
		},
		"stop_containers": {
			Name:    "컨테이너 정지",
			Execute: h.stopContainers,
			NextStep: func(result *StepResult) string {
				// 정지 후 다시 실행중인 컨테이너 확인
				return "check_running_containers"
			},
			Timeout: 120 * time.Second,
		},
		"check_stopped_containers": {
			Name:    "정지된 컨테이너 확인",
			Execute: h.checkStoppedContainers,
			NextStep: func(result *StepResult) string {
				containers := result.Data.([]string)
				if len(containers) > 0 {
					return "remove_containers"
				}
				return "remove_volumes"
			},
			Timeout: 10 * time.Second,
		},
		"remove_containers": {
			Name:    "컨테이너 제거",
			Execute: h.removeContainers,
			NextStep: func(result *StepResult) string {
				// 제거 후 다시 정지된 컨테이너 확인
				return "check_stopped_containers"
			},
			Timeout: 60 * time.Second,
		},
		"remove_volumes": {
			Name:    "볼륨 제거",
			Execute: h.removeVolumes,
			NextStep: func(result *StepResult) string {
				return "check_remaining_volumes"
			},
			Timeout: 30 * time.Second,
		},
		"check_remaining_volumes": {
			Name:    "남은 볼륨 확인",
			Execute: h.checkRemainingVolumes,
			NextStep: func(result *StepResult) string {
				volumes := result.Data.([]string)
				if len(volumes) > 0 {
					return "remove_volumes" // 다시 볼륨 제거 시도
				}
				return "update_service_file"
			},
			Timeout: 10 * time.Second,
		},
		"update_service_file": {
			Name:    "서비스 파일 업데이트",
			Execute: h.updateServiceFile,
			NextStep: func(result *StepResult) string {
				return "restart_service" // 마지막에 재시작
			},
			Timeout: 20 * time.Second,
		},
		"restart_service": {
			Name:    "서비스 재시작",
			Execute: h.restartServiceStep,
			NextStep: func(result *StepResult) string {
				return "" // 워크플로우 완료
			},
			Timeout: 30 * time.Second,
		},
	})
}

// logging은 Homey 서비스 로그를 실시간으로 보여줍니다
// logging은 Homey 디바이스의 로그를 실시간으로 스트리밍합니다 (프로세스 ID 반환)
func (h *HomeyHandler) Logging(cm *ConnectionManager, filter string) (int, error) {
	// 현재 연결 상태 확인
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return 0, fmt.Errorf("연결이 설정되어 있지 않거나 연결되어 있지 않습니다")
	}

	// 연결 ID 확인 및 기본 설정을 연결 설정으로 복사
	connectionID := cm.GetCurrentConnectionID()
	if connectionID != "" {
		// 기본 설정이 있는지 확인
		defaultConfig := cm.GetDefaultLoggingConfig()
		util.Log(util.ColorCyan, "🔍 [디버그] 기본 설정 확인: %+v\n", defaultConfig)

		if defaultConfig != nil && defaultConfig.Configured && len(defaultConfig.LogSources) > 0 {
			// 현재 연결의 설정 확인
			currentConfig, err := cm.GetLoggingConfig(connectionID)
			util.Log(util.ColorCyan, "🔍 [디버그] 현재 연결 설정: %+v, 오류: %v\n", currentConfig, err)

			if err != nil || !currentConfig.Configured || len(currentConfig.LogSources) == 0 {
				// 연결 설정이 없거나 비어있으면 기본 설정을 복사해서 저장
				util.Log(util.ColorCyan, "📋 기본 로깅 설정을 현재 연결에 적용합니다...\n")

				// 기본 설정을 복사
				newConfig := &LoggingConfig{
					Configured: true,
					LogTypes:   make([]string, len(defaultConfig.LogTypes)),
					LogSources: make(map[string]string),
				}
				copy(newConfig.LogTypes, defaultConfig.LogTypes)
				for k, v := range defaultConfig.LogSources {
					newConfig.LogSources[k] = v
				}

				err := cm.SetLoggingConfig(connectionID, newConfig)
				if err != nil {
					util.Log(util.ColorYellow, "⚠️ 기본 설정 적용 실패 (무시): %v\n", err)
				} else {
					util.Log(util.ColorGreen, "✅ 기본 설정이 연결에 적용되었습니다.\n")
				}
			}
		}
	}

	// 메뉴 루프
	for {
		// 현재 연결 정보 및 로깅 설정 표시
		connectionID := cm.GetCurrentConnectionID()

		// 로깅 설정 상태 표시
		if connectionID != "" {
			cm.displayCurrentLoggingConfigWithStatus(connectionID)
		} else {
			// 연결 정보가 없어도 기본 로깅 설정을 테이블로 표시
			util.Log(util.ColorCyan, "\n=== 📋 로깅 설정 ===\n")

			// 기본 설정 가져오기
			defaultConfig := cm.GetDefaultLoggingConfig()

			// 테이블 헤더
			util.Log(util.ColorWhite, "%-15s %-35s %-15s\n", "모듈", "소스", "상태")
			util.Log(util.ColorWhite, "%s\n", strings.Repeat("-", 65))

			// 시스템 정의 모듈들을 테이블로 표시
			for _, module := range SYSTEM_LOG_MODULES {
				var source, status string
				if defaultConfig != nil && defaultConfig.Configured {
					if src, exists := defaultConfig.LogSources[module]; exists {
						source = src
						status = "✅ 설정됨"
					} else {
						source = "미설정"
						status = "⚠️ 미설정"
					}
				} else {
					source = "미설정"
					status = "⚠️ 연결 없음"
				}
				util.Log(util.ColorWhite, "%-15s %-35s %-15s\n", module, source, status)
			}

			if defaultConfig != nil && defaultConfig.Configured {
				util.Log(util.ColorCyan, "\n💡 기본 설정이 구성되어 있습니다. 연결 후 자동으로 적용됩니다.\n")
			} else {
				util.Log(util.ColorCyan, "\n💡 연결 후 설정을 구성할 수 있습니다.\n")
			}
		}

		// 메뉴 옵션 표시
		util.Log(util.ColorCyan, "\n=== 🚀 로깅 메뉴 ===\n")
		util.Log(util.ColorWhite, "1) 실행\n")
		util.Log(util.ColorWhite, "2) 수정\n")
		util.Log(util.ColorWhite, "3) 메뉴 종료\n")
		util.Log(util.ColorYellow, "\n선택하세요 (1-3, Enter=실행): ")

		choice := cm.getUserInput()

		// 엔터는 실행으로 처리
		if choice == "" {
			choice = "1"
		}

		switch choice {
		case "1":
			// 현재 설정으로 실행 (다중 소스 또는 기존 homey 로깅)
			return h.executeLogViewerWithCurrentConfig(cm, filter)
		case "2":
			// 설정 수정 (연결 정보가 없어도 가능하도록)
			var err error
			if connectionID != "" {
				err = cm.ShowLoggingConfigMenu()
				if err != nil {
					util.Log(util.ColorRed, "❌ 설정 수정 실패: %v\n", err)
				}
			} else {
				// 연결 정보가 없으면 기본 설정 생성 메뉴 제공
				err = h.showBasicLoggingConfigMenu(cm)
				if err != nil {
					util.Log(util.ColorRed, "❌ 설정 생성 실패: %v\n", err)
				}
			}
			// 설정 수정 후 메뉴를 다시 표시하기 위해 continue
			continue
		case "3":
			// 메뉴 종료
			util.Log(util.ColorCyan, "로깅 메뉴를 종료합니다.\n")
			return 0, nil
		default:
			util.Log(util.ColorRed, "❌ 잘못된 선택입니다\n")
			continue
		}
	}
}

// executeLogViewerWithCurrentConfig: 현재 설정으로 로그 뷰어 실행
func (h *HomeyHandler) executeLogViewerWithCurrentConfig(cm *ConnectionManager, filter string) (int, error) {
	connectionID := cm.GetCurrentConnectionID()
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		return 0, fmt.Errorf("로깅 설정을 가져올 수 없습니다: %v", err)
	}

	if !loggingConfig.Configured || len(loggingConfig.LogSources) == 0 {
		util.Log(util.ColorYellow, "⚠️ 로깅 설정이 없습니다. 기본 system 로깅을 실행합니다.")
		// 기본 설정으로 system 로그 수집
		defaultConfig := &LoggingConfig{
			Configured: true,
			LogSources: map[string]string{
				"system": "journalctl -f",
			},
		}
		return h.executeConfiguredLogging(cm, defaultConfig, filter)
	}

	// 설정된 로그 소스들로 로그 뷰어 실행
	util.Log(util.ColorGreen, "🚀 설정된 로그 소스로 로그 뷰어를 실행합니다...")
	util.Log(util.ColorCyan, "📋 활성 로그 소스:")
	for logType, source := range loggingConfig.LogSources {
		util.Log(util.ColorWhite, "  - %s: %s", logType, source)
	}

	return h.executeConfiguredLogging(cm, loggingConfig, filter)
}

// executeConfiguredLogging: 설정된 로그 소스들을 기반으로 로그 수집 실행
func (h *HomeyHandler) executeConfiguredLogging(cm *ConnectionManager, loggingConfig *LoggingConfig, filter string) (int, error) {
	// 연결 상태 확인
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return 0, fmt.Errorf("연결이 설정되어 있지 않거나 연결되어 있지 않습니다")
	}

	util.Log(util.ColorCyan, "📋 설정된 로그 소스들로 로그 수집을 시작합니다...")
	for logType, source := range loggingConfig.LogSources {
		util.Log(util.ColorWhite, "  - [%s]: %s", logType, source)
	}

	// LogBuffer 생성 (하이브리드 모드 - 메모리 + 파일)
	logBuffer := logviewer.NewLogBufferByType(logviewer.BufferTypeHybrid)

	// 각 로그 소스를 별도 goroutine에서 실행
	var streamCommands []*exec.Cmd
	for logType, command := range loggingConfig.LogSources {
		util.Log(util.ColorCyan, "🚀 [%s] 로그 스트리밍 시작: %s", logType, command)

		var streamCmd *exec.Cmd
		switch conn := cm.currentConnection.(type) {
		case *ADBConnection:
			streamCmd = exec.Command("adb", "-s", conn.deviceID, "shell", command)
		case *SSHConnection:
			sshArgs := []string{"-p", conn.port, fmt.Sprintf("%s@%s", conn.user, conn.host), command}
			streamCmd = exec.Command("ssh", sshArgs...)
		default:
			return 0, fmt.Errorf("지원되지 않는 연결 타입")
		}

		// 각 로그 타입별로 LogBuffer에 직접 쓰는 Writer 생성
		logWriter := &LogBufferWriter{
			logType:   logType,
			logBuffer: logBuffer,
			filter:    filter,
		}

		streamCmd.Stdout = logWriter
		streamCmd.Stderr = logWriter

		// 백그라운드에서 로그 스트리밍 시작
		err := streamCmd.Start()
		if err != nil {
			util.Log(util.ColorRed, "❌ [%s] 로그 스트리밍 시작 실패: %v", logType, err)
			continue
		}

		streamCommands = append(streamCommands, streamCmd)
		util.Log(util.ColorGreen, "✅ [%s] 로그 스트리밍 시작됨 (PID: %d)", logType, streamCmd.Process.Pid)
	}

	if len(streamCommands) == 0 {
		return 0, fmt.Errorf("실행 가능한 로그 명령어가 없습니다")
	}

	// LogBuffer 상태 모니터링 고루틴
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				// LogBuffer 통계 출력
				stats := logBuffer.GetStats()
				util.Log(util.ColorCyan, "🔍 [LogBuffer 상태] 총 로그: %d, 클라이언트: %d, 최대: %d\n",
					stats["total_logs"], stats["total_clients"], stats["max_size"])

				// 프로세스 상태 확인
				activeCount := 0
				for i, cmd := range streamCommands {
					if cmd.Process != nil && (cmd.ProcessState == nil || !cmd.ProcessState.Exited()) {
						activeCount++
					} else {
						util.Log(util.ColorYellow, "⚠️ [모니터링] 스트림 %d 종료됨", i)
					}
				}

				if activeCount == 0 {
					util.Log(util.ColorRed, "❌ [모니터링] 모든 로그 스트림이 종료됨")
					logBuffer.Close()
					return
				}

			default:
				time.Sleep(1 * time.Second)
			}
		}
	}()

	// UI 로그 뷰어를 별도 고루틴에서 즉시 실행
	go func() {
		util.Log(util.ColorCyan, "UI 로그 뷰어를 시작합니다...\n")
		logviewer.ShowLogViewer(logBuffer)

		// UI가 종료되면 모든 스트리밍 프로세스 종료
		for _, cmd := range streamCommands {
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
		}

		logBuffer.Close()
		util.Log(util.ColorGreen, "LogBuffer 기반 로그 뷰어 및 스트리밍 종료됨\n")
	}()

	util.Log(util.ColorYellow, "LogBuffer 기반 로그 뷰어가 곧 시작됩니다...\n")
	util.Log(util.ColorYellow, "로그 뷰어 창을 닫으면 모든 로그 스트리밍이 중단됩니다.\n")

	// 첫 번째 명령어의 PID 반환 (대표 PID)
	if len(streamCommands) > 0 && streamCommands[0].Process != nil {
		return streamCommands[0].Process.Pid, nil
	}

	return 0, nil
}

// LogBufferWriter는 로그 출력을 LogBuffer에 직접 쓰는 Writer입니다
type LogBufferWriter struct {
	logType   string
	logBuffer logviewer.LogBufferInterface
	filter    string
}

func (lw *LogBufferWriter) Write(data []byte) (int, error) {
	lines := strings.Split(string(data), "\n")

	for _, line := range lines {
		if line == "" {
			continue
		}

		// 필터 적용 (있는 경우)
		if lw.filter != "" && !strings.Contains(strings.ToLower(line), strings.ToLower(lw.filter)) {
			continue
		}

		// LogEntry 생성 및 LogBuffer에 추가
		entry := logviewer.ParseLogLine(line, 0) // index는 LogBuffer에서 관리
		if entry != nil {
			entry.Type = lw.logType   // 로그 타입 설정
			entry.Source = lw.logType // 출처를 로그 타입으로 설정
			lw.logBuffer.AddLog(*entry)
		}
	}

	return len(data), nil
}

// PrefixedWriter는 각 라인에 프리픽스를 추가하는 Writer입니다
type PrefixedWriter struct {
	prefix string
	buffer *bytes.Buffer
}

func (pw *PrefixedWriter) Write(data []byte) (int, error) {
	lines := strings.Split(string(data), "\n")

	for i, line := range lines {
		if i == len(lines)-1 && line == "" {
			// 마지막 빈 줄은 스킵
			continue
		}

		// 각 라인에 프리픽스 추가하여 버퍼에 쓰기
		prefixedLine := pw.prefix + line + "\n"
		pw.buffer.WriteString(prefixedLine)
	}

	return len(data), nil
}

// GetHomeyServiceName은 Homey 서비스 이름을 찾습니다 (Public 메서드)
func (h *HomeyHandler) GetHomeyServiceName(cm *ConnectionManager) (string, error) {
	// 캐시에 서비스 이름이 있으면 바로 반환
	if h.serviceNameCache != "" {
		util.Log(util.ColorGreen, "캐시된 서비스 이름 사용: %s\n", h.serviceNameCache)
		return h.serviceNameCache, nil
	}

	// 연결 상태 확인
	if cm == nil || cm.currentConnection == nil {
		return "", fmt.Errorf("연결이 설정되지 않았습니다")
	}
	if !cm.currentConnection.IsConnected() {
		return "", fmt.Errorf("연결이 활성화되지 않았습니다")
	}

	// systemctl 명령어 시도
	output, err := ExcuteOnShell(cm, "systemctl list-units | grep homey-pro@")

	if err == nil && strings.TrimSpace(output) != "" {
		// 공백 문자 제거 후 줄 분리
		cleanOutput := strings.TrimSpace(output)
		if cleanOutput != "" && !strings.Contains(cleanOutput, "/bin/sh:") && !strings.Contains(cleanOutput, "command not found") {
			lines := strings.Split(cleanOutput, "\n")

			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line != "" && strings.Contains(line, "homey-pro@") {
					fields := strings.Fields(line)
					for _, field := range fields {
						if strings.Contains(field, "homey-pro@") && strings.HasSuffix(field, ".service") {
							serviceName := field
							util.Log(util.ColorGreen, "서비스 발견: %s\n", serviceName)
							// 캐시에 저장
							h.serviceNameCache = serviceName
							return serviceName, nil
						}
					}
				}
			}
		}
	}
	return "", fmt.Errorf("homey 서비스 파일을 찾을 수 없습니다")
}

// EnableDevToken enables development token mode
func (h *HomeyHandler) EnableDevToken(cm *ConnectionManager) error {
	// SSH 연결 시 homey 설치 여부 확인
	if _, ok := cm.currentConnection.(*SSHConnection); ok {
		_, err := h.GetHomeyServiceName(cm)
		if err != nil {
			return fmt.Errorf("SSH 디바이스에 homey가 설치되어 있지 않아 테스트를 건너뜁니다")
		}
	}

	util.Log(util.ColorCyan, "개발 토큰 모드를 활성화합니다...\n")
	// 파일시스템을 읽기/쓰기 모드로 마운트
	_, err := ExcuteOnShell(cm, "mount -o remount,rw /")
	if err != nil {
		return fmt.Errorf("파일시스템 마운트 실패: %v", err)
	}

	// sed 스크립트로 환경변수 추가
	sedScript := `/ALLOW_DEVTOKEN/d
/^ExecStart=/a\  --env="ALLOW_DEVTOKEN=1" \\`

	if err = CreateAndExecuteScript(cm, "sed", "enable_devtoken", sedScript, "/lib/systemd/system/homey-pro@.service"); err != nil {
		return fmt.Errorf("개발 토큰 활성화 실패: %v", err)
	}

	// daemon-reload 및 서비스 재시작
	_, err = ExcuteOnShell(cm, "systemctl daemon-reload")
	if err != nil {
		return fmt.Errorf("daemon-reload 실패: %v", err)
	}

	if err := h.Restart(cm); err != nil {
		return fmt.Errorf("서비스 재시작 실패: %v", err)
	}

	util.Log(util.ColorGreen, "✅ 개발 토큰 모드가 활성화되었습니다\n")
	return nil
}

// DisableDevToken disables development token mode
func (h *HomeyHandler) DisableDevToken(cm *ConnectionManager) error {
	// SSH 연결 시 homey 설치 여부 확인
	if _, ok := cm.currentConnection.(*SSHConnection); ok {
		_, err := h.GetHomeyServiceName(cm)
		if err != nil {
			return fmt.Errorf("SSH 디바이스에 homey가 설치되어 있지 않아 테스트를 건너뜁니다")
		}
	}

	util.Log(util.ColorCyan, "개발 토큰 모드를 비활성화합니다...\n")
	// 파일시스템을 읽기/쓰기 모드로 마운트
	_, err := ExcuteOnShell(cm, "mount -o remount,rw /")
	if err != nil {
		return fmt.Errorf("파일시스템 마운트 실패: %v", err)
	}

	// sed 스크립트로 환경변수 제거
	sedScript := `/ALLOW_DEVTOKEN/d`

	if err = CreateAndExecuteScript(cm, "sed", "disable_devtoken", sedScript, "/lib/systemd/system/homey-pro@.service"); err != nil {
		return fmt.Errorf("개발 토큰 비활성화 실패: %v", err)
	}

	// daemon-reload
	_, err = ExcuteOnShell(cm, "systemctl daemon-reload")
	if err != nil {
		return fmt.Errorf("daemon-reload 실패: %v", err)
	}

	if err := h.Restart(cm); err != nil {
		return fmt.Errorf("서비스 재시작 실패: %v", err)
	}

	util.Log(util.ColorGreen, "✅ 개발 토큰 모드가 비활성화되었습니다\n")
	return nil
}

// EnableAppLog enables application log to console mode
func (h *HomeyHandler) EnableAppLog(cm *ConnectionManager) error {
	// SSH 연결 시 homey 설치 여부 확인
	if _, ok := cm.currentConnection.(*SSHConnection); ok {
		_, err := h.GetHomeyServiceName(cm)
		if err != nil {
			return fmt.Errorf("SSH 디바이스에 homey가 설치되어 있지 않아 테스트를 건너뜁니다")
		}
	}

	util.Log(util.ColorCyan, "앱 로그 콘솔 출력을 활성화합니다...\n")
	// 파일시스템을 읽기/쓰기 모드로 마운트
	_, err := ExcuteOnShell(cm, "mount -o remount,rw /")
	if err != nil {
		return fmt.Errorf("파일시스템 마운트 실패: %v", err)
	}

	// sed 스크립트로 환경변수 추가
	sedScript := `/HOMEY_APP_LOG_TO_CONSOLE/d
/^ExecStart=/a\  --env="HOMEY_APP_LOG_TO_CONSOLE=1" \\`

	if err = CreateAndExecuteScript(cm, "sed", "enable_app_log", sedScript, "/lib/systemd/system/homey-pro@.service"); err != nil {
		return fmt.Errorf("앱 로그 활성화 실패: %v", err)
	}

	// daemon-reload 및 서비스 재시작
	_, err = ExcuteOnShell(cm, "systemctl daemon-reload")
	if err != nil {
		return fmt.Errorf("daemon-reload 실패: %v", err)
	}

	if err := h.Restart(cm); err != nil {
		return fmt.Errorf("서비스 재시작 실패: %v", err)
	}

	util.Log(util.ColorGreen, "✅ 앱 로그 콘솔 출력이 활성화되었습니다\n")
	return nil
}

// DisableAppLog disables application log to console mode
func (h *HomeyHandler) DisableAppLog(cm *ConnectionManager) error {
	// SSH 연결 시 homey 설치 여부 확인
	if _, ok := cm.currentConnection.(*SSHConnection); ok {
		_, err := h.GetHomeyServiceName(cm)
		if err != nil {
			return fmt.Errorf("SSH 디바이스에 homey가 설치되어 있지 않아 테스트를 건너뜁니다")
		}
	}

	util.Log(util.ColorCyan, "앱 로그 콘솔 출력을 비활성화합니다...\n")
	// 파일시스템을 읽기/쓰기 모드로 마운트
	_, err := ExcuteOnShell(cm, "mount -o remount,rw /")
	if err != nil {
		return fmt.Errorf("파일시스템 마운트 실패: %v", err)
	}

	// sed 스크립트로 환경변수 제거
	sedScript := `/HOMEY_APP_LOG_TO_CONSOLE/d`

	if err = CreateAndExecuteScript(cm, "sed", "disable_app_log", sedScript, "/lib/systemd/system/homey-pro@.service"); err != nil {
		return fmt.Errorf("앱 로그 비활성화 실패: %v", err)
	}

	// daemon-reload
	_, err = ExcuteOnShell(cm, "systemctl daemon-reload")
	if err != nil {
		return fmt.Errorf("daemon-reload 실패: %v", err)
	}

	if err := h.Restart(cm); err != nil {
		return fmt.Errorf("서비스 재시작 실패: %v", err)
	}

	util.Log(util.ColorGreen, "✅ 앱 로그 콘솔 출력이 비활성화되었습니다\n")
	return nil
}

// UpdateHomey updates the Homey Docker image with a new image file
func (h *HomeyHandler) UpdateHomey(cm *ConnectionManager, imagePath string, tempPath string) error {
	util.Log(util.ColorCyan, "Homey 이미지 업데이트를 시작합니다...\n")
	util.Log(util.ColorCyan, "이미지 파일: %s\n", imagePath)
	util.Log(util.ColorCyan, "임시 경로: %s\n", tempPath)

	// 연결 상태 확인
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return fmt.Errorf("연결이 설정되어 있지 않거나 연결되어 있지 않습니다. 먼저 연결을 설정하세요")
	}

	// 1. 입력 검증
	if tempPath == "" {
		return fmt.Errorf("임시 경로가 필요합니다")
	}

	// 임시 경로 마지막이 /로 끝나는지 확인
	if !strings.HasSuffix(tempPath, "/") {
		return fmt.Errorf("임시 경로의 마지막은 /로 끝나야 합니다")
	}

	// 2. 로컬 파일 존재 확인
	if _, err := os.Stat(imagePath); os.IsNotExist(err) {
		return fmt.Errorf("이미지 파일이 존재하지 않습니다: %s", imagePath)
	}

	// 3. 언마운트 실행
	util.Log(util.ColorYellow, "기존 마운트를 해제합니다...\n")
	if err := h.Unmount(cm); err != nil {
		util.Log(util.ColorYellow, "언마운트 중 오류 발생 (계속 진행): %v\n", err)
	}

	// 4. 기존 Docker 이미지 제거
	util.Log(util.ColorCyan, "기존 Docker 이미지를 제거합니다...\n")
	if err := h.removeExistingImages(cm); err != nil {
		util.Log(util.ColorYellow, "기존 이미지 제거 중 오류 발생 (계속 진행): %v\n", err)
	}

	// 5. 이미지 파일 복사
	util.Log(util.ColorCyan, "이미지 파일을 기기로 복사합니다...\n")
	filename := filepath.Base(imagePath)
	destPath := tempPath + filename

	if err := PushFile(cm, imagePath, destPath); err != nil {
		return fmt.Errorf("이미지 파일 복사 실패: %v", err)
	}

	// 6. Docker 이미지 로드
	util.Log(util.ColorCyan, "Docker 이미지를 로드합니다...\n")
	loadCmd := fmt.Sprintf("docker load -i %s", destPath)
	if _, err := ExcuteOnShell(cm, loadCmd); err != nil {
		return fmt.Errorf("Docker 이미지 로드 실패: %v", err)
	}

	// 7. 임시 파일 삭제
	util.Log(util.ColorCyan, "임시 파일을 삭제합니다...\n")
	removeCmd := fmt.Sprintf("rm %s", destPath)
	if _, err := ExcuteOnShell(cm, removeCmd); err != nil {
		util.Log(util.ColorYellow, "임시 파일 삭제 실패 (무시): %v\n", err)
	}

	// 8. 서비스 재시작
	util.Log(util.ColorCyan, "Homey 서비스를 재시작합니다...\n")
	if err := h.Restart(cm); err != nil {
		return fmt.Errorf("서비스 재시작 실패: %v", err)
	}

	util.Log(util.ColorBrightGreen, "✅ Homey 이미지 업데이트가 완료되었습니다!\n")
	return nil
}

// removeExistingImages removes all existing Docker images
func (h *HomeyHandler) removeExistingImages(cm *ConnectionManager) error {
	// Docker 이미지 목록 조회
	output, err := ExcuteOnShell(cm, "docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}'")
	if err != nil {
		return fmt.Errorf("Docker 이미지 목록 조회 실패: %v", err)
	}

	if strings.TrimSpace(output) == "" {
		util.Log(util.ColorCyan, "제거할 Docker 이미지가 없습니다.\n")
		return nil
	}

	lines := strings.Split(strings.TrimSpace(output), "\n")
	imageCount := 0

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}

		// 이미지 ID 추출 (마지막 부분)
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			imageID := parts[len(parts)-1]

			// 이미지 제거
			removeCmd := fmt.Sprintf("docker rmi -f %s", imageID)
			if _, err := ExcuteOnShell(cm, removeCmd); err != nil {
				util.Log(util.ColorYellow, "이미지 제거 실패 %s: %v\n", imageID, err)
			} else {
				imageCount++
				util.Log(util.ColorCyan, "이미지 제거됨: %s\n", imageID)
			}
		}
	}

	util.Log(util.ColorGreen, "총 %d개의 Docker 이미지가 제거되었습니다.\n", imageCount)
	return nil
}

// showBasicLoggingConfigMenu: 연결 정보가 없을 때 기본 로깅 설정 메뉴
func (h *HomeyHandler) showBasicLoggingConfigMenu(cm *ConnectionManager) error {
	util.Log(util.ColorCyan, "\n=== 📝 기본 로깅 설정 생성 ===\n")
	util.Log(util.ColorYellow, "연결 정보가 없지만 로깅 설정을 미리 구성할 수 있습니다.\n")

	// 기본 설정 정보 가져오기
	defaultConfig := cm.GetDefaultLoggingConfig()

	// 시스템 정의 모듈들 표시 (테이블 형식)
	util.Log(util.ColorCyan, "📋 시스템 정의 모듈들:\n")
	util.Log(util.ColorWhite, "%-15s %-35s %-15s\n", "모듈", "소스", "상태")
	util.Log(util.ColorWhite, "%s\n", strings.Repeat("-", 65))

	for i, module := range SYSTEM_LOG_MODULES {
		var source, status string
		if defaultConfig != nil && defaultConfig.Configured {
			if src, exists := defaultConfig.LogSources[module]; exists {
				source = src
				status = "설정됨"
			} else {
				source = "미설정"
				status = "미설정"
			}
		} else {
			source = "미설정"
			status = "미설정"
		}
		util.Log(util.ColorWhite, "%d) %-12s %-35s %-15s\n", i+1, module, source, status)
	}

	util.Log(util.ColorCyan, "\n=== 🛠️ 설정 메뉴 ===\n")
	util.Log(util.ColorWhite, "1) 모듈별 로깅 방법 설정\n")
	util.Log(util.ColorWhite, "2) 전체 기본 설정 생성\n")
	util.Log(util.ColorWhite, "3) 뒤로\n")
	util.Log(util.ColorYellow, "\n선택하세요 (1-3): ")

	choice := cm.getUserInput()

	switch choice {
	case "1":
		err := h.setupIndividualModules(cm)
		if err != nil {
			util.Log(util.ColorRed, "❌ 모듈 설정 중 오류: %v\n", err)
		}
		// 설정 완료 후 다시 메뉴로 돌아가기
		return h.showBasicLoggingConfigMenu(cm)
	case "2":
		err := h.createDefaultConfiguration(cm)
		if err != nil {
			util.Log(util.ColorRed, "❌ 기본 설정 생성 중 오류: %v\n", err)
		}
		// 설정 완료 후 다시 메뉴로 돌아가기
		return h.showBasicLoggingConfigMenu(cm)
	case "3":
		util.Log(util.ColorYellow, "⬅️ 뒤로 이동합니다\n")
		return nil
	default:
		util.Log(util.ColorRed, "❌ 잘못된 선택입니다\n")
		return nil
	}
}

// setupIndividualModules: 개별 모듈 설정
func (h *HomeyHandler) setupIndividualModules(cm *ConnectionManager) error {
	util.Log(util.ColorCyan, "\n=== 📝 개별 모듈 설정 ===\n")

	// 공통 모듈 선택 함수 사용
	selectedModule, err := cm.promptModuleSelection()
	if err != nil {
		util.Log(util.ColorRed, "❌ %s\n", err.Error())
		return nil
	}

	// 해당 모듈의 로깅 방법 설정 (연결 타입에 관계없이 동일)
	source := cm.promptLogSource(selectedModule, "")
	if source == "" {
		util.Log(util.ColorYellow, "⚠️ 설정이 취소되었습니다\n")
		return nil
	}

	// 기본 로깅 설정에 추가
	defaultConfig := cm.GetDefaultLoggingConfig()
	if defaultConfig == nil {
		defaultConfig = &LoggingConfig{
			Configured: true,
			LogSources: make(map[string]string),
		}
	}
	defaultConfig.LogSources[selectedModule] = source
	defaultConfig.Configured = true

	// 설정 저장
	err = cm.SetDefaultLoggingConfig(defaultConfig)
	if err != nil {
		util.Log(util.ColorRed, "❌ 설정 저장 실패: %v\n", err)
		return err
	}

	util.Log(util.ColorGreen, "✅ [%s] 모듈 설정 완료: %s\n", selectedModule, source)
	util.Log(util.ColorCyan, "💡 실제 연결 후 이 설정이 적용됩니다.\n")

	return nil
}

// createDefaultConfiguration: 전체 기본 설정 생성
func (h *HomeyHandler) createDefaultConfiguration(cm *ConnectionManager) error {
	util.Log(util.ColorCyan, "\n=== 📋 전체 기본 설정 생성 ===\n")

	// 기본 설정 생성 (연결 타입에 관계없이 동일한 로그 소스)
	defaultConfig := cm.getDefaultLoggingConfig("")

	// 기본 로깅 설정에 저장
	err := cm.SetDefaultLoggingConfig(&defaultConfig)
	if err != nil {
		util.Log(util.ColorRed, "❌ 설정 저장 실패: %v\n", err)
		return err
	}

	util.Log(util.ColorGreen, "✅ 기본 설정 생성 완료:\n")
	util.Log(util.ColorCyan, "📋 기본 로그 소스들:\n")
	for logType, source := range defaultConfig.LogSources {
		util.Log(util.ColorWhite, "  - %s: %s\n", logType, source)
	}

	util.Log(util.ColorCyan, "💡 실제 연결 후 이 설정이 자동으로 적용됩니다.\n")

	return nil
}

// LoggingSimple은 시스템 로그를 실시간으로 보여줍니다 (간소화된 버전)
func (h *HomeyHandler) LoggingSimple(cm *ConnectionManager, filter string) (int, error) {
	// 연결 상태 확인
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return 0, fmt.Errorf("연결이 설정되어 있지 않거나 연결되어 있지 않습니다")
	}

	util.Log(util.ColorCyan, "📋 시스템 로그 뷰어를 시작합니다...")

	// LogBuffer 생성 (하이브리드 모드)
	logBuffer := logviewer.NewLogBufferByType(logviewer.BufferTypeHybrid)

	// journalctl 명령어 구성 (전체 시스템 로그)
	var logCmd string
	if filter != "" {
		logCmd = fmt.Sprintf("journalctl -f | grep -i '%s'", filter)
		util.Log(util.ColorYellow, "🔍 필터 적용: %s", filter)
	} else {
		logCmd = "journalctl -f"
	}

	util.Log(util.ColorCyan, "📋 실행 명령어: %s", logCmd)

	// 연결 타입에 따른 명령어 실행
	var streamCmd *exec.Cmd
	switch conn := cm.currentConnection.(type) {
	case *SSHConnection:
		// SSH 연결인 경우
		streamCmd = exec.Command("ssh",
			"-o", "StrictHostKeyChecking=no",
			fmt.Sprintf("%s@%s", conn.user, conn.host),
			logCmd)
	case *ADBConnection:
		// ADB 연결인 경우
		streamCmd = exec.Command("adb", "-s", conn.deviceID, "shell", logCmd)
	default:
		return 0, fmt.Errorf("지원하지 않는 연결 타입입니다")
	}

	// LogBuffer Writer 생성 (system 타입으로 변경)
	logWriter := &LogBufferWriter{
		logType:   "system",
		logBuffer: logBuffer,
		filter:    "", // 필터는 이미 명령어에 적용됨
	}

	streamCmd.Stdout = logWriter
	streamCmd.Stderr = logWriter

	// 백그라운드에서 로그 스트리밍 시작
	err := streamCmd.Start()
	if err != nil {
		return 0, fmt.Errorf("로그 스트리밍 시작 실패: %v", err)
	}

	util.Log(util.ColorGreen, "✅ 로그 스트리밍 시작됨 (PID: %d)", streamCmd.Process.Pid)

	// 프로세스 종료 감지 고루틴
	go func() {
		streamCmd.Wait()
		util.Log(util.ColorRed, "❌ 로그 스트리밍 종료됨")
		logBuffer.Close()
	}()

	// 웹 로그 뷰어 시작 (별도 고루틴)
	go func() {
		util.Log(util.ColorCyan, "🌐 웹 로그 뷰어를 시작합니다...")
		logviewer.ShowLogViewer(logBuffer)

		// UI가 종료되면 스트리밍 프로세스도 종료
		if streamCmd.Process != nil {
			streamCmd.Process.Kill()
		}
	}()

	util.Log(util.ColorYellow, "💡 웹 로그 뷰어가 곧 열립니다. 창을 닫으면 로그 스트리밍이 중단됩니다.")

	return streamCmd.Process.Pid, nil
}
