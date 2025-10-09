package lib

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"edgetool/util"
)

// ETCHandler는 일반적인 유틸리티 명령어들을 처리합니다
type ETCHandler struct {
	BaseHandler
	processManager *util.ProcessResourceManager
}

// NewETCHandler creates a new ETCHandler instance
func NewETCHandler() *ETCHandler {
	return &ETCHandler{
		processManager: util.NewProcessResourceManager(),
	}
}

// Shell opens an interactive shell to the connected device
func (h *ETCHandler) Shell(cm *ConnectionManager) error {
	// 연결 상태 확인
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return fmt.Errorf("연결이 설정되어 있지 않거나 연결되어 있지 않습니다. 먼저 연결을 설정하세요")
	}

	// 연결 타입에 따라 다른 shell 실행
	switch conn := cm.currentConnection.(type) {
	case *ADBConnection:
		return h.openADBShell(conn)
	case *SSHConnection:
		return h.openSSHShell(conn)
	default:
		return fmt.Errorf("지원하지 않는 연결 타입입니다: %s", cm.currentConnection.GetType())
	}
}

// openADBShell opens ADB shell in new terminal window
func (h *ETCHandler) openADBShell(conn *ADBConnection) error {
	util.Log(util.ColorCyan, "새로운 CMD 창에서 ADB shell을 시작합니다...\n")
	util.Log(util.ColorYellow, "shell 창을 닫으려면 해당 창에서 'exit'를 입력하거나 창을 닫으세요.\n")

	// PowerShell Start-Process를 사용하여 새로운 창에서 ADB shell 실행
	adbCommand := fmt.Sprintf("adb -s %s shell", conn.deviceID)
	psCommand := fmt.Sprintf("Start-Process -FilePath 'cmd' -ArgumentList '/k', '%s'", strings.ReplaceAll(adbCommand, "'", "''"))

	cmd := exec.Command("powershell", "-Command", psCommand)
	if err := cmd.Start(); err != nil {
		return err
	}
	
	// 프로세스 추적
	h.processManager.AddProcess(cmd.Process.Pid)
	util.Log(util.ColorGreen, "ADB shell 프로세스 추적 중 (PID: %d)\n", cmd.Process.Pid)
	
	return nil
}

// openSSHShell opens SSH shell in new terminal window
func (h *ETCHandler) openSSHShell(conn *SSHConnection) error {
	util.Log(util.ColorCyan, "새로운 터미널 창에서 SSH shell을 시작합니다...\n")
	util.Log(util.ColorYellow, "shell 창을 닫으려면 해당 창에서 'exit'를 입력하거나 창을 닫으세요.\n")

	// SSH 연결 정보를 가져와서 터미널 명령어 구성
	sshCommand := h.buildSSHCommand(conn)
	
	// 플랫폼별 터미널 실행
	return h.executeTerminalCommand(sshCommand)
}

// buildSSHCommand builds SSH command string from connection info
func (h *ETCHandler) buildSSHCommand(conn *SSHConnection) string {
	host := conn.host
	user := conn.user
	portStr := conn.port
	
	// 빈 포트나 기본 포트(22)는 -p 옵션 생략
	if portStr == "" || portStr == "22" {
		return fmt.Sprintf("ssh %s@%s", user, host)
	}
	
	// 그 외 포트는 -p 옵션 사용
	return fmt.Sprintf("ssh -p %s %s@%s", portStr, user, host)
}

// executeTerminalCommand executes command in new terminal window based on platform
func (h *ETCHandler) executeTerminalCommand(sshCommand string) error {
	var cmd *exec.Cmd
	
	// CMD 창에 고유한 타이틀을 주어 추적 가능하도록 함
	windowTitle := fmt.Sprintf("EdgeTool-Shell-%d", os.Getpid())
	psCommand := fmt.Sprintf("Start-Process -FilePath 'cmd' -ArgumentList '/k', 'title %s && %s'", 
			windowTitle, strings.ReplaceAll(sshCommand, "'", "''"))
	cmd = exec.Command("powershell", "-Command", psCommand)
	
	if err := cmd.Start(); err != nil {
		return err
	}
	
	// 프로세스 추적 (PowerShell 프로세스)
	h.processManager.AddProcess(cmd.Process.Pid)
	util.Log(util.ColorGreen, "SSH shell 프로세스 추적 중 (PID: %d, 창 타이틀: %s)\n", cmd.Process.Pid, windowTitle)
	
	return nil
}

// getServerURL returns the server URL based on GGIT_SERVER environment variable
func (h *ETCHandler) getServerURL() string {
	ggitServer := os.Getenv("GGIT_SERVER")
	if ggitServer == "" {
		// 기본값 설정 (batch 파일의 기본값과 동일)
		ggitServer = "https://svc-ggit.bee0.lge.com"
	}
	return ggitServer
}

// Server sends a command to the server and saves the response to workspace folder
func (h *ETCHandler) Server(cm *ConnectionManager, command string) error {
	if command == "" {
		return fmt.Errorf("server 명령이 필요합니다")
	}

	// GGIT_SERVER 환경변수 읽기
	ggitServer := h.getServerURL()

	util.Log(util.ColorCyan, "서버에 명령을 전송합니다: %s\n", command)

	// JSON 데이터 생성
	requestData := fmt.Sprintf(`{"cmd": "%s"}`, command)

	// HTTP POST 요청 생성
	url := fmt.Sprintf("%s/cmd", ggitServer)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer([]byte(requestData)))
	if err != nil {
		return fmt.Errorf("HTTP 요청 생성 실패: %v", err)
	}

	// 헤더 설정
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	// HTTP 클라이언트 생성 및 요청 실행
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("서버 요청 실패: %v", err)
	}
	defer resp.Body.Close()

	// 응답 본문 읽기
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("응답 읽기 실패: %v", err)
	}

	filePath := filepath.Join("./", "server_response.json")

	// JSON 포맷팅 시도
	var parsedData interface{}
	if err := json.Unmarshal(body, &parsedData); err == nil {
		// JSON인 경우 이쁘게 포맷팅하여 파일에 저장
		prettyJSON, err := json.MarshalIndent(parsedData, "", "  ")
		if err == nil {
			err = os.WriteFile(filePath, prettyJSON, 0644)
			if err != nil {
				return fmt.Errorf("파일 저장 실패: %v", err)
			}
		} else {
			// 포맷팅 실패 시 원본 저장
			err = os.WriteFile(filePath, body, 0644)
			if err != nil {
				return fmt.Errorf("파일 저장 실패: %v", err)
			}
		}
	} else {
		// JSON이 아닌 경우 원본 저장
		err = os.WriteFile(filePath, body, 0644)
		if err != nil {
			return fmt.Errorf("파일 저장 실패: %v", err)
		}
	}

	util.Log(util.ColorGreen, "서버 응답이 workspace/server_response.json 파일에 저장되었습니다.\n")
	return nil
}

// Cleanup terminates all tracked processes
func (h *ETCHandler) Cleanup() {
	if h.processManager != nil {
		util.Log(util.ColorCyan, "실행 중인 shell 프로세스들을 정리합니다...\n")
		h.processManager.Cleanup()
		util.Log(util.ColorGreen, "shell 프로세스 정리 완료\n")
	}
}
