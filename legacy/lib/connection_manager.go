package lib

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"edgetool/util"
)

// 시스템에 정의된 로깅 모듈들
var SYSTEM_LOG_MODULES = []string{
	"system",
	"kernel",
}

// LoggingConfig: 로깅 설정 구조체
type LoggingConfig struct {
	Configured bool              `json:"configured"`
	LogTypes   []string          `json:"log_types"`
	LogSources map[string]string `json:"log_sources"`
}

// ConnectionInfo: 개별 연결 정보 구조체
type ConnectionInfo struct {
	ID       string            `json:"id"`
	Alias    string            `json:"alias,omitempty"`
	Type     string            `json:"type"`
	Details  map[string]string `json:"details"`
	LastUsed string            `json:"lastUsed"`
	Logging  *LoggingConfig    `json:"logging,omitempty"`
}

// Config: 연결 설정 저장 구조체
type Config struct {
	Recent               string           `json:"recent"`
	Connections          []ConnectionInfo `json:"connections"`
	DefaultLoggingConfig *LoggingConfig   `json:"defaultLoggingConfig,omitempty"`
}

// Connection 인터페이스: 연결 방식 추상화
type Connection interface {
	Connect() error
	Disconnect() error
	GetType() string
	IsConnected() bool
}

// ADBConnection: ADB 연결 구현
type ADBConnection struct {
	deviceID  string
	connected bool
}

func (a *ADBConnection) Connect() error {
	// ADB 기기 목록 가져오기
	cmd := exec.Command("cmd", "/c", "adb devices")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ADB 연결 실패")
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) < 2 {
		return fmt.Errorf("연결된 ADB 기기가 없습니다")
	}

	// 기기 목록 파싱
	devices := make(map[string]bool)
	deviceList := []string{}
	for _, line := range lines[1:] { // 첫 번째 줄("List of devices attached") 무시
		line = strings.TrimSpace(line)
		if line == "" {
			continue // 빈 줄 무시
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 && parts[1] == "device" {
			deviceID := parts[0]
			if !devices[deviceID] { // 중복 방지
				devices[deviceID] = true
				deviceList = append(deviceList, deviceID)
			}
		}
	}

	if len(deviceList) == 0 {
		return fmt.Errorf("연결된 ADB 기기가 없습니다")
	}

	// 기존 deviceID가 있으면 유효한지 확인
	if a.deviceID != "" {
		if devices[a.deviceID] {
			// 연결 테스트
			testCmd := exec.Command("cmd", "/c", fmt.Sprintf("adb -s %s shell echo 'ADB 연결 성공'", a.deviceID))
			_, err := testCmd.CombinedOutput()
			if err == nil {
				a.connected = true
				util.Log(util.ColorGreen, "ADB 연결됨: %s\n", a.deviceID)
				return nil
			}
			util.Log(util.ColorRed, "ADB 연결 실패\n")
		} else {
			util.Log(util.ColorRed, "기존 deviceID %s가 목록에 없습니다.\n", a.deviceID)
		}
	}

	// 기기 선택
	util.Log(util.ColorCyan, "연결할 ADB 기기를 선택하세요:\n")
	for i, deviceID := range deviceList {
		util.Log("%d. %s\n", i+1, deviceID)
	}

	// 여러 기기가 있는 경우 사용자 선택
	for {
		util.Log(util.ColorCyan, "기기 번호 선택 (1-%d, q=뒤로가기): ", len(deviceList))

		var input string
		_, err := fmt.Scanln(&input)
		if err != nil {
			// 입력 에러 시 버퍼 정리
			var discard string
			fmt.Scanln(&discard)
			util.Log(util.ColorRed, "잘못된 입력입니다. 다시 시도하세요.\n")
			continue
		}

		input = strings.TrimSpace(input)
		if input == "" {
			util.Log(util.ColorRed, "입력이 비어있습니다. 다시 시도하세요.\n")
			continue
		}

		// 숫자 변환 시도 또는 q 확인
		var choice int
		_, err = fmt.Sscanf(input, "%d", &choice)
		if err != nil {
			// 숫자가 아닌 경우 q인지 확인
			if strings.ToLower(input) == "q" {
				return fmt.Errorf("사용자 요청: 뒤로가기")
			}
			util.Log(util.ColorRed, "숫자(1-%d) 또는 q를 입력하세요. 다시 시도하세요.\n", len(deviceList))
			continue
		}

		if choice < 1 || choice > len(deviceList) {
			util.Log(util.ColorRed, "잘못된 선택입니다. 1-%d 사이의 숫자를 입력하세요.\n", len(deviceList))
			continue
		}

		a.deviceID = deviceList[choice-1]
		a.connected = true
		util.Log(util.ColorGreen, "ADB 연결됨: %s\n", a.deviceID)
		return nil
	}
}

func (a *ADBConnection) Disconnect() error {
	a.connected = false
	util.Log(util.ColorGreen, "ADB 연결 해제됨\n")
	return nil
}

func (a *ADBConnection) GetType() string {
	return "ADB"
}

func (a *ADBConnection) IsConnected() bool {
	return a.connected
}

// SSHConnection: SSH 연결 구현
type SSHConnection struct {
	host      string
	user      string
	password  string
	port      string
	connected bool
}

func (s *SSHConnection) Connect() error {
	// 기존 세부 정보가 있으면 사용: host/user/port만 있으면 테스트 실행
	if s.host != "" && s.user != "" && s.port != "" {
		// 비밀번호 인증 방식으로 SSH 연결 테스트
		testCmd := fmt.Sprintf("ssh -o ConnectTimeout=5 -p %s %s@%s true",
			s.port, s.user, s.host)
		out, err := exec.Command("cmd", "/c", testCmd).CombinedOutput()
		if err == nil {
			s.connected = true
			util.Log(util.ColorGreen, "SSH 연결됨: %s@%s:%s\n", s.user, s.host, s.port)
			return nil
		}
		outStr := strings.TrimSpace(string(out))
		low := strings.ToLower(outStr)
		if outStr == "" {
			return fmt.Errorf("기존 SSH 연결 실패: %v", err)
		}
		// sanitize common messages
		if strings.Contains(low, "not recognized") || strings.Contains(low, "command not found") {
			return fmt.Errorf("SSH 실행 불가: ssh 클라이언트가 설치되어 있지 않거나 PATH에 없습니다")
		}
		if strings.Contains(low, "permission denied") {
			return fmt.Errorf("SSH 인증 실패: 인증 키 또는 사용자 정보(권한) 확인 필요")
		}
		if strings.Contains(low, "could not resolve") || strings.Contains(low, "unknown host") {
			return fmt.Errorf("SSH 호스트를 찾을 수 없음: 호스트명 또는 네트워크를 확인하세요")
		}
		return fmt.Errorf("기존 SSH 연결 실패: %s", outStr)
	}

	// SSH 설정 입력
	reader := bufio.NewReader(os.Stdin)

	util.Log(util.ColorCyan, "SSH 호스트: ")
	host, _ := reader.ReadString('\n')
	s.host = strings.TrimSpace(host)

	util.Log(util.ColorCyan, "SSH 사용자: ")
	user, _ := reader.ReadString('\n')
	s.user = strings.TrimSpace(user)

	util.Log(util.ColorCyan, "SSH 패스워드: ")
	password, _ := reader.ReadString('\n')
	s.password = strings.TrimSpace(password)

	util.Log(util.ColorCyan, "SSH 포트 (기본 22): ")
	port, _ := reader.ReadString('\n')
	port = strings.TrimSpace(port)
	if port == "" {
		port = "22"
	}
	s.port = port

	// 연결 테스트 (Go SSH 라이브러리 사용)
	output, err := sshCommandRunner(s, "ssh", "true")
	if err != nil {
		return fmt.Errorf("SSH 연결 테스트 실패: %v", err)
	}

	s.connected = true
	util.Log(util.ColorGreen, "SSH 연결됨: %s@%s:%s\n", s.user, s.host, s.port)
	util.Log(util.ColorGreen, "연결 테스트 결과: %s", strings.TrimSpace(output))
	return nil
}

func (s *SSHConnection) Disconnect() error {
	s.connected = false
	util.Log(util.ColorGreen, "SSH 연결 해제됨\n")
	return nil
}

func (s *SSHConnection) GetType() string {
	return "SSH"
}

func (s *SSHConnection) IsConnected() bool {
	return s.connected
}

// ConnectionManager: 연결 관리
type ConnectionManager struct {
	currentConnection    Connection
	configFile           string
	config               *Config
	defaultLoggingConfig *LoggingConfig // 연결 정보가 없을 때의 기본 로깅 설정
}

func NewConnectionManager() *ConnectionManager {
	projectRoot, err := getProjectRoot()
	if err != nil {
		util.Log(util.ColorRed, "프로젝트 루트 찾기 실패: %v", err)
		projectRoot = "." // fallback
	}
	return &ConnectionManager{
		configFile: filepath.Join(projectRoot, ".config", "connection_config.json"),
		config:     &Config{Connections: []ConnectionInfo{}},
		defaultLoggingConfig: &LoggingConfig{
			Configured: false,
			LogSources: make(map[string]string),
		},
	}
}

func (cm *ConnectionManager) LoadConfig() error {
	if _, err := os.Stat(cm.configFile); os.IsNotExist(err) {
		return nil // 설정 파일 없음
	}

	data, err := os.ReadFile(cm.configFile)
	if err != nil {
		return err
	}

	err = json.Unmarshal(data, cm.config)
	if err != nil {
		return err
	}

	// 기본 로깅 설정 로드
	if cm.config.DefaultLoggingConfig != nil {
		cm.defaultLoggingConfig = cm.config.DefaultLoggingConfig
	}

	// 최근 연결 찾기
	if cm.config.Recent != "" {
		for _, connInfo := range cm.config.Connections {
			if connInfo.ID == cm.config.Recent {
				// 최근 연결 객체 생성
				switch connInfo.Type {
				case "ADB":
					a := &ADBConnection{}
					if did, ok := connInfo.Details["deviceID"]; ok {
						a.deviceID = did
					}
					cm.currentConnection = a
				case "SSH":
					s := &SSHConnection{}
					if v, ok := connInfo.Details["host"]; ok {
						s.host = v
					}
					if v, ok := connInfo.Details["user"]; ok {
						s.user = v
					}
					if v, ok := connInfo.Details["port"]; ok {
						s.port = v
					}
					if v, ok := connInfo.Details["password"]; ok {
						s.password = v
					}
					cm.currentConnection = s
				}
				break
			}
		}
	}

	return nil
}

func (cm *ConnectionManager) SaveConfig() error {
	// Ensure directory exists
	dir := filepath.Dir(cm.configFile)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("failed to create config directory %s: %w", dir, err)
		}
	}

	// 연결이 있을 때만 연결 정보 업데이트
	if cm.currentConnection != nil {
		// 현재 연결의 ID 생성
		var currentID string
		var details map[string]string
		switch conn := cm.currentConnection.(type) {
		case *ADBConnection:
			currentID = "ADB_" + conn.deviceID
			details = map[string]string{
				"deviceID": conn.deviceID,
			}
		case *SSHConnection:
			currentID = "SSH_" + conn.host + "_" + conn.user
			details = map[string]string{
				"host":     conn.host,
				"user":     conn.user,
				"password": conn.password,
				"port":     conn.port,
			}
		}

		// 기존 연결 찾기 또는 새로 추가
		found := false
		for i, connInfo := range cm.config.Connections {
			if connInfo.ID == currentID {
				// 기존 연결 업데이트
				cm.config.Connections[i].LastUsed = fmt.Sprintf("%d", time.Now().Unix())
				found = true
				break
			}
		}

		if !found {
			// 새 연결 추가
			newConn := ConnectionInfo{
				ID:       currentID,
				Type:     cm.currentConnection.GetType(),
				Details:  details,
				LastUsed: fmt.Sprintf("%d", time.Now().Unix()),
			}
			cm.config.Connections = append(cm.config.Connections, newConn)

			// 최대 5개 유지 (가장 오래된 것부터 삭제)
			if len(cm.config.Connections) > 5 {
				// LastUsed 기준으로 정렬하여 가장 오래된 것 삭제
				sort.Slice(cm.config.Connections, func(i, j int) bool {
					return cm.config.Connections[i].LastUsed < cm.config.Connections[j].LastUsed
				})
				cm.config.Connections = cm.config.Connections[1:]
			}
		}

		// 최근 연결 업데이트
		cm.config.Recent = currentID
	}

	// 기본 로깅 설정 저장
	cm.config.DefaultLoggingConfig = cm.defaultLoggingConfig

	data, err := json.MarshalIndent(cm.config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(cm.configFile, data, 0644)
}

func (cm *ConnectionManager) SetupConnection() error {
	// 기존 설정 로드
	err := cm.LoadConfig()
	if err != nil {
		return err
	}

	// 최근 연결이 있으면 자동 연결 물어보기
	if cm.currentConnection != nil && cm.config != nil && cm.config.Recent != "" {
		// 최근 연결 정보 상세 표시
		util.Log(util.ColorCyan, "최근 연결 발견:\n")
		for _, connInfo := range cm.config.Connections {
			if connInfo.ID == cm.config.Recent {
				// 별칭이 있으면 별칭 표시, 없으면 ID 표시
				displayName := connInfo.ID
				if connInfo.Alias != "" {
					displayName = connInfo.Alias
				}
				util.Log(util.ColorCyan, "  이름: %s\n", displayName)

				switch connInfo.Type {
				case "ADB":
					if did, ok := connInfo.Details["deviceID"]; ok {
						util.Log(util.ColorCyan, "  타입: ADB\n")
						util.Log(util.ColorCyan, "  기기 ID: %s\n", did)
					}
				case "SSH":
					util.Log(util.ColorCyan, "  타입: SSH\n")
					if host, ok := connInfo.Details["host"]; ok {
						util.Log(util.ColorCyan, "  호스트: %s\n", host)
					}
					if user, ok := connInfo.Details["user"]; ok {
						util.Log(util.ColorCyan, "  사용자: %s\n", user)
					}
					if port, ok := connInfo.Details["port"]; ok && port != "" {
						util.Log(util.ColorCyan, "  포트: %s\n", port)
					} else {
						util.Log(util.ColorCyan, "  포트: 22 (기본값)\n")
					}
				}
				break
			}
		}

		util.Log(util.ColorCyan, "최근 연결로 자동 연결하시겠습니까? (Y/n): ")
		reader := bufio.NewReader(os.Stdin)
		response, err := reader.ReadString('\n')
		if err != nil {
			util.Log(util.ColorRed, "입력 읽기 실패: %v\n", err)
			return err
		}

		response = strings.ToLower(strings.TrimSpace(response))
		if response == "" {
			response = "y" // 기본값 (엔터만 누른 경우)
		}

		if response == "y" {
			err := cm.currentConnection.Connect()
			if err == nil {
				util.Log(util.ColorGreen, "최근 연결 성공!\n")
				return nil
			}
			util.Log(util.ColorRed, "최근 연결 실패: %v\n", err)
		}

		// 최근 연결 실패 또는 'n' 선택 시 기존 연결 리스트 물어보기
		util.Log(util.ColorCyan, "기존 연결 리스트를 보시겠습니까? (Y/n): ")
		listResponse, err := reader.ReadString('\n')
		if err != nil {
			util.Log(util.ColorRed, "입력 읽기 실패: %v\n", err)
			return err
		}

		listResponse = strings.ToLower(strings.TrimSpace(listResponse))
		if listResponse == "" {
			listResponse = "y" // 기본값 (엔터만 누른 경우)
		}

		if listResponse == "y" {
			return cm.selectFromExistingConnections()
		}
	}

	// 새 연결 설정
	return cm.createNewConnection()
}

// 기존 연결 리스트에서 선택
func (cm *ConnectionManager) selectFromExistingConnections() error {
	if len(cm.config.Connections) == 0 {
		util.Log(util.ColorYellow, "저장된 연결이 없습니다. 새 연결을 설정합니다.\n")
		return cm.createNewConnection()
	}

	for {
		util.Log(util.ColorCyan, "저장된 연결 목록:\n")
		for i, conn := range cm.config.Connections {
			var detail string
			switch conn.Type {
			case "ADB":
				if did, ok := conn.Details["deviceID"]; ok {
					detail = fmt.Sprintf("ADB: %s", did)
				}
			case "SSH":
				if host, ok := conn.Details["host"]; ok {
					if user, ok := conn.Details["user"]; ok {
						port := "22"
						if p, ok := conn.Details["port"]; ok && p != "" {
							port = p
						}
						detail = fmt.Sprintf("SSH: %s@%s:%s", user, host, port)
					}
				}
			}

			// 별칭이 있으면 별칭 표시, 없으면 ID 표시
			displayName := conn.ID
			if conn.Alias != "" {
				displayName = conn.Alias
			}

			util.Log("%d. %s (%s)\n", i+1, displayName, detail)
		}
		util.Log("0. 새 연결 설정\n")
		util.Log("M. 연결 관리 메뉴\n")
		util.Log(util.ColorCyan, "선택: ")

		var input string
		_, err := fmt.Scanln(&input)
		if err != nil {
			// 입력 에러 시 버퍼 정리
			var discard string
			fmt.Scanln(&discard)
			util.Log(util.ColorRed, "잘못된 입력입니다. 다시 시도하세요.\n")
			continue
		}

		input = strings.TrimSpace(input)
		if input == "" {
			util.Log(util.ColorRed, "입력이 비어있습니다. 다시 시도하세요.\n")
			continue
		}

		// 숫자 변환 시도
		var choice int
		_, numErr := fmt.Sscanf(input, "%d", &choice)

		// 숫자가 아닌 경우 영문 메뉴 처리
		if numErr != nil {
			inputUpper := strings.ToUpper(input)
			if inputUpper == "M" {
				err := cm.showConnectionManagementMenu()
				if err != nil {
					util.Log(util.ColorRed, "연결 관리 메뉴 오류: %v\n", err)
				}
				continue
			} else {
				util.Log(util.ColorRed, "잘못된 입력입니다. 숫자(0-%d) 또는 M을 입력하세요.\n", len(cm.config.Connections))
				continue
			}
		}

		if choice == 0 {
			return cm.createNewConnection()
		}

		if choice < 1 || choice > len(cm.config.Connections) {
			util.Log(util.ColorRed, "잘못된 선택입니다. 0-%d 사이의 숫자를 입력하세요.\n", len(cm.config.Connections))
			continue
		}

		selectedConn := cm.config.Connections[choice-1]

		// 선택된 연결로 currentConnection 설정
		switch selectedConn.Type {
		case "ADB":
			a := &ADBConnection{}
			if did, ok := selectedConn.Details["deviceID"]; ok {
				a.deviceID = did
			}
			cm.currentConnection = a
		case "SSH":
			s := &SSHConnection{}
			if v, ok := selectedConn.Details["host"]; ok {
				s.host = v
			}
			if v, ok := selectedConn.Details["user"]; ok {
				s.user = v
			}
			if v, ok := selectedConn.Details["port"]; ok {
				s.port = v
			}
			if v, ok := selectedConn.Details["password"]; ok {
				s.password = v
			}
			cm.currentConnection = s
		}

		err = cm.currentConnection.Connect()
		if err != nil {
			util.Log(util.ColorRed, "선택한 연결 실패: %v\n다시 선택하세요.\n", err)
			continue
		}

		// 선택된 연결에 별칭이 없으면 입력 요청
		if selectedConn.Alias == "" {
			util.Log(util.ColorCyan, "선택한 연결에 별칭이 없습니다. 별칭을 추가하시겠습니까? (Y/n): ")
			reader := bufio.NewReader(os.Stdin)
			aliasResponse, _ := reader.ReadString('\n')
			aliasResponse = strings.ToLower(strings.TrimSpace(aliasResponse))
			if aliasResponse == "" || aliasResponse == "y" {
				alias := cm.inputAlias()
				if alias != "" {
					// 설정에서 별칭 업데이트
					for i, connInfo := range cm.config.Connections {
						if connInfo.ID == selectedConn.ID {
							cm.config.Connections[i].Alias = alias
							break
						}
					}
				}
			}
		}

		util.Log(util.ColorGreen, "연결 성공!\n")
		return cm.SaveConfig()
	}
}

// 새 연결 생성
func (cm *ConnectionManager) createNewConnection() error {
	for {
		util.Log(util.ColorCyan, "새 연결을 설정합니다.\n")
		util.Log("1. ADB 연결\n")
		util.Log("2. SSH 연결\n")
		util.Log("n. 연결 안함\n")
		util.Log(util.ColorCyan, "선택: ")

		var input string
		_, err := fmt.Scanln(&input)
		if err != nil {
			// 입력 에러 시 버퍼 정리
			var discard string
			fmt.Scanln(&discard)
			util.Log(util.ColorRed, "잘못된 입력입니다. 다시 시도하세요.\n")
			continue
		}

		input = strings.TrimSpace(input)
		if input == "" {
			util.Log(util.ColorRed, "입력이 비어있습니다. 다시 시도하세요.\n")
			continue
		}

		// "n" 입력 시 연결 안함으로 처리
		var choice int
		if input == "n" || input == "N" {
			choice = 3
		} else {
			// 숫자 변환 시도
			_, err = fmt.Sscanf(input, "%d", &choice)
			if err != nil {
				util.Log(util.ColorRed, "숫자를 입력하세요. 다시 시도하세요.\n")
				continue
			}
		}

		switch choice {
		case 1:
			cm.currentConnection = &ADBConnection{}
			err := cm.currentConnection.Connect()
			if err != nil {
				util.Log(util.ColorRed, "ADB 연결 실패: %v\n", err)
				continue
			}

			// 별칭 입력
			alias := cm.inputAlias()
			cm.updateExistingConnectionIfNeeded(alias)

			util.Log(util.ColorGreen, "ADB 연결 성공!\n")
			return cm.SaveConfig()
		case 2:
			cm.currentConnection = &SSHConnection{}
			err := cm.currentConnection.Connect()
			if err != nil {
				util.Log(util.ColorRed, "SSH 연결 실패: %v\n", err)
				continue
			}

			// 별칭 입력
			alias := cm.inputAlias()
			cm.updateExistingConnectionIfNeeded(alias)

			util.Log(util.ColorGreen, "SSH 연결 성공!\n")
			return cm.SaveConfig()
		case 3:
			util.Log(util.ColorYellow, "연결 없이 프로그램을 계속 사용합니다.\n")
			return nil
		default:
			util.Log(util.ColorRed, "잘못된 선택입니다. 1, 2 또는 3을 입력하세요.\n")
			continue
		}
	}
}

// 별칭 입력 메소드
func (cm *ConnectionManager) inputAlias() string {
	reader := bufio.NewReader(os.Stdin)

	util.Log(util.ColorCyan, "별칭을 입력하세요 (선택사항, 엔터 시 ID 사용): ")
	alias, _ := reader.ReadString('\n')
	alias = strings.TrimSpace(alias)

	if alias == "" {
		util.Log(util.ColorYellow, "별칭이 입력되지 않아 ID를 사용합니다.\n")
	}

	return alias
}

// 기존 연결 업데이트 확인 및 별칭 설정
func (cm *ConnectionManager) updateExistingConnectionIfNeeded(alias string) {
	if cm.currentConnection == nil {
		return
	}

	var currentID string
	switch conn := cm.currentConnection.(type) {
	case *ADBConnection:
		currentID = "ADB_" + conn.deviceID
	case *SSHConnection:
		currentID = "SSH_" + conn.host + "_" + conn.user
	}

	// 기존 연결에서 동일한 ID 찾기
	for i, connInfo := range cm.config.Connections {
		if connInfo.ID == currentID {
			// 기존 연결 업데이트
			switch conn := cm.currentConnection.(type) {
			case *ADBConnection:
				cm.config.Connections[i].Details["deviceID"] = conn.deviceID
			case *SSHConnection:
				cm.config.Connections[i].Details["host"] = conn.host
				cm.config.Connections[i].Details["user"] = conn.user
				cm.config.Connections[i].Details["password"] = conn.password
				cm.config.Connections[i].Details["port"] = conn.port
			}
			cm.config.Connections[i].LastUsed = fmt.Sprintf("%d", time.Now().Unix())

			// 별칭 설정
			if alias != "" {
				cm.config.Connections[i].Alias = alias
			}

			break
		}
	}
}

// 연결 수정 메소드
func (cm *ConnectionManager) editConnection() error {
	if len(cm.config.Connections) == 0 {
		util.Log(util.ColorYellow, "수정할 연결이 없습니다.\n")
		return nil
	}

	util.Log(util.ColorCyan, "\n수정할 연결을 선택하세요:\n")
	for i, conn := range cm.config.Connections {
		displayName := conn.ID
		if conn.Alias != "" {
			displayName = conn.Alias
		}

		var detail string
		switch conn.Type {
		case "ADB":
			if did, ok := conn.Details["deviceID"]; ok {
				detail = fmt.Sprintf("ADB: %s", did)
			}
		case "SSH":
			if host, ok := conn.Details["host"]; ok {
				if user, ok := conn.Details["user"]; ok {
					port := "22"
					if p, ok := conn.Details["port"]; ok && p != "" {
						port = p
					}
					detail = fmt.Sprintf("SSH: %s@%s:%s", user, host, port)
				}
			}
		}
		util.Log("%d. %s (%s)\n", i+1, displayName, detail)
	}
	util.Log("0. 취소\n")
	util.Log(util.ColorCyan, "선택: ")

	var input string
	_, err := fmt.Scanln(&input)
	if err != nil {
		var discard string
		fmt.Scanln(&discard)
		return fmt.Errorf("입력 읽기 실패")
	}

	input = strings.TrimSpace(input)
	var choice int
	_, err = fmt.Sscanf(input, "%d", &choice)
	if err != nil || choice < 0 || choice > len(cm.config.Connections) {
		return fmt.Errorf("잘못된 선택")
	}

	if choice == 0 {
		return nil
	}

	selectedConn := &cm.config.Connections[choice-1]
	return cm.editConnectionDetails(selectedConn)
}

// 연결 세부 정보 수정
func (cm *ConnectionManager) editConnectionDetails(conn *ConnectionInfo) error {
	reader := bufio.NewReader(os.Stdin)

	util.Log(util.ColorCyan, "\n현재 연결 정보:\n")
	displayName := conn.ID
	if conn.Alias != "" {
		displayName = conn.Alias
	}
	util.Log("이름: %s\n", displayName)
	util.Log("타입: %s\n", conn.Type)

	switch conn.Type {
	case "ADB":
		if did, ok := conn.Details["deviceID"]; ok {
			util.Log("기기 ID: %s\n", did)
		}
	case "SSH":
		if host, ok := conn.Details["host"]; ok {
			util.Log("호스트: %s\n", host)
		}
		if user, ok := conn.Details["user"]; ok {
			util.Log("사용자: %s\n", user)
		}
		if port, ok := conn.Details["port"]; ok && port != "" {
			util.Log("포트: %s\n", port)
		}
	}

	util.Log(util.ColorCyan, "\n수정할 항목을 선택하세요:\n")
	util.Log("1. 별칭 변경\n")
	if conn.Type == "ADB" {
		util.Log("2. 기기 ID 변경\n")
	} else if conn.Type == "SSH" {
		util.Log("2. 호스트 변경\n")
		util.Log("3. 사용자 변경\n")
		util.Log("4. 포트 변경\n")
		util.Log("5. 비밀번호 변경\n")
	}
	util.Log("0. 취소\n")
	util.Log(util.ColorCyan, "선택: ")

	var input string
	_, err := fmt.Scanln(&input)
	if err != nil {
		var discard string
		fmt.Scanln(&discard)
		return fmt.Errorf("입력 읽기 실패")
	}

	input = strings.TrimSpace(input)
	var choice int
	_, err = fmt.Sscanf(input, "%d", &choice)
	if err != nil {
		return fmt.Errorf("잘못된 선택")
	}

	switch choice {
	case 0:
		return nil
	case 1:
		// 별칭 변경
		util.Log(util.ColorCyan, "새 별칭 (빈 칸으로 두면 ID 사용): ")
		alias, _ := reader.ReadString('\n')
		conn.Alias = strings.TrimSpace(alias)
	case 2:
		if conn.Type == "ADB" {
			util.Log(util.ColorCyan, "새 기기 ID: ")
			deviceID, _ := reader.ReadString('\n')
			conn.Details["deviceID"] = strings.TrimSpace(deviceID)
		} else if conn.Type == "SSH" {
			util.Log(util.ColorCyan, "새 호스트: ")
			host, _ := reader.ReadString('\n')
			conn.Details["host"] = strings.TrimSpace(host)
		}
	case 3:
		if conn.Type == "SSH" {
			util.Log(util.ColorCyan, "새 사용자: ")
			user, _ := reader.ReadString('\n')
			conn.Details["user"] = strings.TrimSpace(user)
		}
	case 4:
		if conn.Type == "SSH" {
			util.Log(util.ColorCyan, "새 포트 (기본 22): ")
			port, _ := reader.ReadString('\n')
			port = strings.TrimSpace(port)
			if port == "" {
				port = "22"
			}
			conn.Details["port"] = port
		}
	case 5:
		if conn.Type == "SSH" {
			util.Log(util.ColorCyan, "새 비밀번호: ")
			password, _ := reader.ReadString('\n')
			conn.Details["password"] = strings.TrimSpace(password)
		}
	default:
		return fmt.Errorf("잘못된 선택")
	}

	// 변경사항 저장
	conn.LastUsed = fmt.Sprintf("%d", time.Now().Unix())
	err = cm.SaveConfig()
	if err != nil {
		return fmt.Errorf("설정 저장 실패: %v", err)
	}

	util.Log(util.ColorGreen, "연결 정보가 성공적으로 수정되었습니다.\n")
	return nil
}

// 연결 삭제 메소드
func (cm *ConnectionManager) deleteConnection() error {
	if len(cm.config.Connections) == 0 {
		util.Log(util.ColorYellow, "삭제할 연결이 없습니다.\n")
		return nil
	}

	util.Log(util.ColorCyan, "\n삭제할 연결을 선택하세요:\n")
	for i, conn := range cm.config.Connections {
		displayName := conn.ID
		if conn.Alias != "" {
			displayName = conn.Alias
		}

		var detail string
		switch conn.Type {
		case "ADB":
			if did, ok := conn.Details["deviceID"]; ok {
				detail = fmt.Sprintf("ADB: %s", did)
			}
		case "SSH":
			if host, ok := conn.Details["host"]; ok {
				if user, ok := conn.Details["user"]; ok {
					port := "22"
					if p, ok := conn.Details["port"]; ok && p != "" {
						port = p
					}
					detail = fmt.Sprintf("SSH: %s@%s:%s", user, host, port)
				}
			}
		}
		util.Log("%d. %s (%s)\n", i+1, displayName, detail)
	}
	util.Log("0. 취소\n")
	util.Log(util.ColorCyan, "선택: ")

	var input string
	_, err := fmt.Scanln(&input)
	if err != nil {
		var discard string
		fmt.Scanln(&discard)
		return fmt.Errorf("입력 읽기 실패")
	}

	input = strings.TrimSpace(input)
	var choice int
	_, err = fmt.Sscanf(input, "%d", &choice)
	if err != nil || choice < 0 || choice > len(cm.config.Connections) {
		return fmt.Errorf("잘못된 선택")
	}

	if choice == 0 {
		return nil
	}

	selectedConn := cm.config.Connections[choice-1]
	displayName := selectedConn.ID
	if selectedConn.Alias != "" {
		displayName = selectedConn.Alias
	}

	// 삭제 확인
	util.Log(util.ColorYellow, "정말로 '%s' 연결을 삭제하시겠습니까? (y/N): ", displayName)
	var confirm string
	fmt.Scanln(&confirm)
	confirm = strings.ToLower(strings.TrimSpace(confirm))

	if confirm != "y" && confirm != "yes" {
		util.Log(util.ColorCyan, "삭제가 취소되었습니다.\n")
		return nil
	}

	// 최근 연결인 경우 경고
	if cm.config.Recent == selectedConn.ID {
		util.Log(util.ColorYellow, "⚠️  경고: 이 연결은 최근에 사용한 연결입니다.\n")
		util.Log(util.ColorYellow, "계속 삭제하시겠습니까? (y/N): ")
		var finalConfirm string
		fmt.Scanln(&finalConfirm)
		finalConfirm = strings.ToLower(strings.TrimSpace(finalConfirm))

		if finalConfirm != "y" && finalConfirm != "yes" {
			util.Log(util.ColorCyan, "삭제가 취소되었습니다.\n")
			return nil
		}
	}

	// 연결 삭제
	cm.config.Connections = append(cm.config.Connections[:choice-1], cm.config.Connections[choice:]...)

	// 최근 연결이 삭제된 경우 초기화
	if cm.config.Recent == selectedConn.ID {
		if len(cm.config.Connections) > 0 {
			cm.config.Recent = cm.config.Connections[0].ID
		} else {
			cm.config.Recent = ""
		}
	}

	// 설정 저장
	err = cm.SaveConfig()
	if err != nil {
		return fmt.Errorf("설정 저장 실패: %v", err)
	}

	util.Log(util.ColorGreen, "'%s' 연결이 성공적으로 삭제되었습니다.\n", displayName)
	return nil
}

// 연결 별칭 변경 메소드
func (cm *ConnectionManager) changeConnectionAlias() error {
	if len(cm.config.Connections) == 0 {
		util.Log(util.ColorYellow, "별칭을 변경할 연결이 없습니다.\n")
		return nil
	}

	util.Log(util.ColorCyan, "\n별칭을 변경할 연결을 선택하세요:\n")
	for i, conn := range cm.config.Connections {
		displayName := conn.ID
		if conn.Alias != "" {
			displayName = conn.Alias
		}

		var detail string
		switch conn.Type {
		case "ADB":
			if did, ok := conn.Details["deviceID"]; ok {
				detail = fmt.Sprintf("ADB: %s", did)
			}
		case "SSH":
			if host, ok := conn.Details["host"]; ok {
				if user, ok := conn.Details["user"]; ok {
					port := "22"
					if p, ok := conn.Details["port"]; ok && p != "" {
						port = p
					}
					detail = fmt.Sprintf("SSH: %s@%s:%s", user, host, port)
				}
			}
		}
		util.Log("%d. %s (%s)\n", i+1, displayName, detail)
	}
	util.Log("0. 취소\n")
	util.Log(util.ColorCyan, "선택: ")

	var input string
	_, err := fmt.Scanln(&input)
	if err != nil {
		var discard string
		fmt.Scanln(&discard)
		return fmt.Errorf("입력 읽기 실패")
	}

	input = strings.TrimSpace(input)
	var choice int
	_, err = fmt.Sscanf(input, "%d", &choice)
	if err != nil || choice < 0 || choice > len(cm.config.Connections) {
		return fmt.Errorf("잘못된 선택")
	}

	if choice == 0 {
		return nil
	}

	selectedConn := &cm.config.Connections[choice-1]
	reader := bufio.NewReader(os.Stdin)

	util.Log(util.ColorCyan, "새 별칭 (빈 칸으로 두면 ID 사용): ")
	alias, _ := reader.ReadString('\n')
	selectedConn.Alias = strings.TrimSpace(alias)
	selectedConn.LastUsed = fmt.Sprintf("%d", time.Now().Unix())

	// 설정 저장
	err = cm.SaveConfig()
	if err != nil {
		return fmt.Errorf("설정 저장 실패: %v", err)
	}

	displayName := selectedConn.ID
	if selectedConn.Alias != "" {
		displayName = selectedConn.Alias
	}
	util.Log(util.ColorGreen, "'%s'의 별칭이 성공적으로 변경되었습니다.\n", displayName)
	return nil
}

// 연결 관리 메뉴 표시
func (cm *ConnectionManager) showConnectionManagementMenu() error {
	for {
		util.Log(util.ColorCyan, "\n연결 관리 메뉴:\n")
		util.Log("1. 연결 수정\n")
		util.Log("2. 연결 삭제\n")
		util.Log("3. 연결 별칭 변경\n")
		util.Log("0. 이전 메뉴로 돌아가기\n")
		util.Log(util.ColorCyan, "선택: ")

		var input string
		_, err := fmt.Scanln(&input)
		if err != nil {
			var discard string
			fmt.Scanln(&discard)
			util.Log(util.ColorRed, "잘못된 입력입니다. 다시 시도하세요.\n")
			continue
		}

		input = strings.TrimSpace(input)
		if input == "" {
			util.Log(util.ColorRed, "입력이 비어있습니다. 다시 시도하세요.\n")
			continue
		}

		var choice int
		_, numErr := fmt.Sscanf(input, "%d", &choice)
		if numErr != nil {
			util.Log(util.ColorRed, "잘못된 입력입니다. 0-4 사이의 숫자를 입력하세요.\n")
			continue
		}

		switch choice {
		case 1:
			err := cm.editConnection()
			if err != nil {
				util.Log(util.ColorRed, "연결 수정 실패: %v\n", err)
			}
		case 2:
			err := cm.deleteConnection()
			if err != nil {
				util.Log(util.ColorRed, "연결 삭제 실패: %v\n", err)
			}
		case 3:
			err := cm.changeConnectionAlias()
			if err != nil {
				util.Log(util.ColorRed, "별칭 변경 실패: %v\n", err)
			}
		case 0:
			return nil
		default:
			util.Log(util.ColorRed, "잘못된 선택입니다. 0-4 사이의 숫자를 입력하세요.\n")
			continue
		}
	}
}

func (cm *ConnectionManager) SwitchConnection() error {
	if cm.currentConnection == nil {
		return fmt.Errorf("현재 연결이 설정되지 않음")
	}

	util.Log(util.ColorCyan, "현재 연결: %s\n", cm.currentConnection.GetType())

	// 기존 연결 리스트 확인 및 표시
	if len(cm.config.Connections) > 0 {
		util.Log(util.ColorCyan, "기존 연결 리스트를 보시겠습니까? (Y/n): ")
		reader := bufio.NewReader(os.Stdin)
		listResponse, err := reader.ReadString('\n')
		if err != nil {
			util.Log(util.ColorRed, "입력 읽기 실패: %v\n", err)
			return err
		}

		listResponse = strings.ToLower(strings.TrimSpace(listResponse))
		if listResponse == "" {
			listResponse = "y" // 기본값 (엔터만 누른 경우)
		}

		if listResponse == "y" {
			return cm.selectFromExistingConnections()
		}
	}

	// 새 연결 설정
	util.Log(util.ColorCyan, "새 연결을 설정하시겠습니까? (Y/n): ")
	var response string
	fmt.Scanln(&response)
	response = strings.ToLower(strings.TrimSpace(response))
	if response == "" || response == "y" {
		util.Log("새 연결을 설정합니다.\n")
		util.Log("1. ADB 연결\n")
		util.Log("2. SSH 연결\n")
		util.Log("선택: ")

		var choice int
		fmt.Scanln(&choice)

		var newConn Connection
		switch choice {
		case 1:
			newConn = &ADBConnection{}
		case 2:
			newConn = &SSHConnection{}
		default:
			return fmt.Errorf("잘못된 선택")
		}

		err := newConn.Connect()
		if err != nil {
			return err
		}

		cm.currentConnection.Disconnect()
		cm.currentConnection = newConn
		return cm.SaveConfig()
	} else {
		util.Log(util.ColorRed, "연결 변경을 취소합니다.\n")
		return nil
	}
}

func (cm *ConnectionManager) GetConnectionInfo() {
	if cm.currentConnection == nil {
		util.Log(util.ColorRed, "연결이 설정되지 않음\n")
		return
	}

	status := "연결됨"
	if !cm.currentConnection.IsConnected() {
		status = "연결되지 않음"
	}

	// 현재 연결의 ID와 별칭 찾기
	var currentID, currentAlias string
	switch conn := cm.currentConnection.(type) {
	case *ADBConnection:
		currentID = "ADB_" + conn.deviceID
	case *SSHConnection:
		currentID = "SSH_" + conn.host + "_" + conn.user
	}

	// 설정에서 별칭 찾기
	for _, connInfo := range cm.config.Connections {
		if connInfo.ID == currentID {
			currentAlias = connInfo.Alias
			break
		}
	}

	// 표시 이름 결정 (별칭 우선)
	displayName := currentID
	if currentAlias != "" {
		displayName = currentAlias
	}

	// 추가 정보: ADB는 deviceID, SSH는 user@host:port 를 표시
	detail := "대상: 설정되지 않음"
	switch conn := cm.currentConnection.(type) {
	case *ADBConnection:
		if conn.deviceID != "" {
			detail = fmt.Sprintf("대상: %s", conn.deviceID)
		} else {
			detail = "대상: (ADB 기기 미지정)"
		}
	case *SSHConnection:
		if conn.user != "" && conn.host != "" {
			port := conn.port
			if port == "" {
				port = "22"
			}
			detail = fmt.Sprintf("대상: %s@%s:%s", conn.user, conn.host, port)
		} else {
			detail = "대상: (SSH 정보 미지정)"
		}
	}

	util.Log(util.ColorCyan, "이름: %s, 타입: %s, 상태: %s, %s\n", displayName, cm.currentConnection.GetType(), status, detail)
}

// GetCurrentConnectionID: 현재 연결의 ID 반환
func (cm *ConnectionManager) GetCurrentConnectionID() string {
	if cm.currentConnection == nil {
		return ""
	}

	// 현재 연결 타입별로 식별
	currentType := cm.currentConnection.GetType()

	for _, conn := range cm.config.Connections {
		if conn.Type == currentType {
			// ADB 연결의 경우
			if currentType == "ADB" {
				if adbConn, ok := cm.currentConnection.(*ADBConnection); ok && adbConn.deviceID != "" {
					if deviceID, exists := conn.Details["deviceID"]; exists && deviceID == adbConn.deviceID {
						return conn.ID
					}
				}
			}
			// SSH 연결의 경우
			if currentType == "SSH" {
				if sshConn, ok := cm.currentConnection.(*SSHConnection); ok {
					if host, hostExists := conn.Details["host"]; hostExists && host == sshConn.host {
						if user, userExists := conn.Details["user"]; userExists && user == sshConn.user {
							return conn.ID
						}
					}
				}
			}
		}
	}

	return ""
}

// ===============================
// 로깅 설정 관리 함수들
// ===============================

// GetLoggingConfig: 특정 연결의 로깅 설정 가져오기
func (cm *ConnectionManager) GetLoggingConfig(connectionID string) (*LoggingConfig, error) {
	for i := range cm.config.Connections {
		if cm.config.Connections[i].ID == connectionID {
			if cm.config.Connections[i].Logging == nil {
				// 로깅 설정이 없으면 기본 설정 생성
				defaultConfig := cm.getDefaultLoggingConfig(cm.config.Connections[i].Type)
				cm.config.Connections[i].Logging = &defaultConfig

				// 설정 저장
				if err := cm.SaveConfig(); err != nil {
					return nil, fmt.Errorf("기본 로깅 설정 저장 실패: %v", err)
				}

				util.Log(util.ColorGreen, "🔧 [%s] 기본 로깅 설정 생성 완료", connectionID)
			}
			return cm.config.Connections[i].Logging, nil
		}
	}
	return nil, fmt.Errorf("연결을 찾을 수 없습니다: %s", connectionID)
}

// SetLoggingConfig: 특정 연결의 로깅 설정 업데이트
func (cm *ConnectionManager) SetLoggingConfig(connectionID string, loggingConfig *LoggingConfig) error {
	for i := range cm.config.Connections {
		if cm.config.Connections[i].ID == connectionID {
			cm.config.Connections[i].Logging = loggingConfig

			// 설정 저장
			if err := cm.SaveConfig(); err != nil {
				return fmt.Errorf("로깅 설정 저장 실패: %v", err)
			}

			util.Log(util.ColorGreen, "✅ [%s] 로깅 설정 업데이트 완료", connectionID)
			return nil
		}
	}
	return fmt.Errorf("연결을 찾을 수 없습니다: %s", connectionID)
}

// SetDefaultLoggingConfig: 기본 로깅 설정 저장 (연결 정보가 없을 때 사용)
func (cm *ConnectionManager) SetDefaultLoggingConfig(loggingConfig *LoggingConfig) error {
	cm.defaultLoggingConfig = loggingConfig

	// 설정 파일에도 저장하도록 수정
	err := cm.SaveConfig()
	if err != nil {
		util.Log(util.ColorRed, "❌ 기본 로깅 설정 저장 실패: %v", err)
		return err
	}

	util.Log(util.ColorGreen, "✅ 기본 로깅 설정 업데이트 완료")
	return nil
}

// GetDefaultLoggingConfig: 기본 로깅 설정 가져오기
func (cm *ConnectionManager) GetDefaultLoggingConfig() *LoggingConfig {
	return cm.defaultLoggingConfig
}

// InitializeLoggingConfig: 연결의 로깅 설정 초기화
func (cm *ConnectionManager) InitializeLoggingConfig(connectionID string) error {
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		return err
	}

	// 이미 구성되어 있으면 스킵
	if loggingConfig.Configured {
		util.Log(util.ColorCyan, "ℹ️ [%s] 로깅 설정이 이미 구성되어 있습니다", connectionID)
		return nil
	}

	util.Log(util.ColorYellow, "🔧 [%s] 로깅 설정 초기화 중...", connectionID)

	// 사용자에게 로깅 설정 구성 제안
	if !cm.promptLoggingSetup(connectionID) {
		return fmt.Errorf("로깅 설정 구성이 취소되었습니다")
	}

	return nil
}

// getDefaultLoggingConfig: 통일된 기본 로깅 설정 반환 (연결 타입 무관)
func (cm *ConnectionManager) getDefaultLoggingConfig(connectionType string) LoggingConfig {
	return LoggingConfig{
		Configured: false,
		LogTypes:   SYSTEM_LOG_MODULES,
		LogSources: map[string]string{
			"system": "cmd:journalctl -f",
			"kernel": "cmd:dmesg -w",
		},
	}
}

// promptLoggingSetup: 사용자에게 로깅 설정 구성 제안
func (cm *ConnectionManager) promptLoggingSetup(connectionID string) bool {
	util.Log(util.ColorCyan, "\n=== 📋 로깅 설정 구성 ===")
	util.Log(util.ColorWhite, "연결 [%s]에 대한 로깅 설정이 필요합니다.", connectionID)

	// 기본 설정 사용 여부 확인
	util.Log(util.ColorYellow, "\n기본 설정을 사용하시겠습니까? (y/n): ")
	response := cm.getUserInput()

	if strings.ToLower(response) == "y" || strings.ToLower(response) == "yes" {
		return cm.applyDefaultLoggingConfig(connectionID)
	}

	// 커스텀 설정 구성
	util.Log(util.ColorCyan, "\n🔧 커스텀 로깅 설정을 구성합니다...")
	return cm.setupCustomLoggingConfig(connectionID)
}

// setupCustomLoggingConfig: 커스텀 로깅 설정 구성
func (cm *ConnectionManager) setupCustomLoggingConfig(connectionID string) bool {
	// 현재 연결 정보 가져오기
	connectionInfo := cm.getConnectionInfo(connectionID)
	if connectionInfo == nil {
		util.Log(util.ColorRed, "❌ 연결 정보를 찾을 수 없습니다")
		return false
	}

	// 기본 로그 타입들 제안
	defaultLogTypes := cm.getDefaultLogTypes(connectionInfo.Type)

	util.Log(util.ColorCyan, "\n=== 📝 로그 타입 설정 ===")
	util.Log(util.ColorWhite, "설정할 로그 타입들 (%s 기본값): %v", connectionInfo.Type, defaultLogTypes)
	util.Log(util.ColorYellow, "기본값을 사용하시겠습니까? (y/n): ")

	var logTypes []string
	if strings.ToLower(cm.getUserInput()) == "y" {
		logTypes = defaultLogTypes
	} else {
		logTypes = cm.promptLogTypes()
	}

	// 각 로그 타입별 소스 설정
	logSources := make(map[string]string)
	for _, logType := range logTypes {
		source := cm.promptLogSource(logType, connectionInfo.Type)
		if source != "" {
			logSources[logType] = source
		}
	}

	// 설정 적용
	newConfig := LoggingConfig{
		Configured: true,
		LogTypes:   logTypes,
		LogSources: logSources,
	}

	return cm.applyCustomLoggingConfig(connectionID, &newConfig)
}

// promptLogSource: 특정 로그 타입의 소스 설정
func (cm *ConnectionManager) promptLogSource(logType, connectionType string) string {
	util.Log(util.ColorCyan, "\n=== 🔍 [%s] 로그 소스 설정 ===\n", logType)

	// 소스 타입 선택
	util.Log(util.ColorWhite, "로그 소스 타입을 선택하세요:\n")
	util.Log(util.ColorWhite, "1) 📁 파일 직접 읽기 (File)\n")
	util.Log(util.ColorWhite, "2) ⚡ 명령어 실행 (Command)\n")
	util.Log(util.ColorYellow, "\n선택하세요 (1-2): ")

	choice := cm.getUserInput()

	switch choice {
	case "1":
		return cm.promptFileSource(logType, connectionType)
	case "2":
		return cm.promptCommandSource(logType, connectionType)
	default:
		util.Log(util.ColorRed, "❌ 잘못된 선택입니다. 기본값을 사용합니다.")
		return cm.getDefaultSourceForLogType(logType, connectionType)
	}
}

// promptFileSource: 파일 소스 입력 받기
func (cm *ConnectionManager) promptFileSource(logType, connectionType string) string {
	util.Log(util.ColorCyan, "\n📁 파일 경로 입력")

	// 예시 제공
	example := cm.getFilePathExample(logType, connectionType)
	util.Log(util.ColorWhite, "예시: %s", example)
	util.Log(util.ColorYellow, "파일 경로를 입력하세요: ")

	path := strings.TrimSpace(cm.getUserInput())
	if path == "" {
		util.Log(util.ColorYellow, "빈 값입니다. 기본값을 사용합니다: %s", example)
		path = example
	}

	return "file:" + path
}

// promptCommandSource: 명령어 소스 입력 받기
func (cm *ConnectionManager) promptCommandSource(logType, connectionType string) string {
	util.Log(util.ColorCyan, "\n⚡ 명령어 입력\n")

	// 예시 제공
	example := cm.getCommandExample(logType, connectionType)
	util.Log(util.ColorWhite, "예시: %s\n", example)
	util.Log(util.ColorYellow, "실행할 명령어를 입력하세요: ")

	command := strings.TrimSpace(cm.getUserInput())
	if command == "" {
		util.Log(util.ColorYellow, "빈 값입니다. 기본값을 사용합니다: %s", example)
		command = example
	}

	return "cmd:" + command
}

// getUserInput: 사용자 입력 받기
func (cm *ConnectionManager) getUserInput() string {
	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	return strings.TrimSpace(input)
}

// promptLogTypes: 커스텀 로그 타입 입력 받기
func (cm *ConnectionManager) promptLogTypes() []string {
	util.Log(util.ColorCyan, "\n📝 로그 타입들을 입력하세요 (쉼표로 구분):")
	util.Log(util.ColorWhite, "예시: system,kernel")
	util.Log(util.ColorYellow, "입력: ")

	input := cm.getUserInput()
	if input == "" {
		return []string{"system"}
	}

	types := strings.Split(input, ",")
	for i := range types {
		types[i] = strings.TrimSpace(types[i])
	}

	return types
}

// getDefaultLogTypes: 연결 타입별 기본 로그 타입들
func (cm *ConnectionManager) getDefaultLogTypes(connectionType string) []string {
	switch connectionType {
	case "ADB":
		return []string{"system", "kernel"}
	case "SSH":
		return []string{"system", "kernel"}
	default:
		return []string{"system"}
	}
}

// getFilePathExample: 로그 타입별 파일 경로 예시 (연결 타입 무관)
func (cm *ConnectionManager) getFilePathExample(logType, connectionType string) string {
	switch logType {
	case "system":
		return "/var/log/messages"
	case "kernel":
		return "/var/log/kernel.log"
	default:
		return "/var/log/" + logType + ".log"
	}
}

// getCommandExample: 로그 타입별 명령어 예시 (연결 타입 무관)
func (cm *ConnectionManager) getCommandExample(logType, connectionType string) string {
	switch logType {
	case "system":
		return "journalctl -f"
	case "kernel":
		return "dmesg -w"
	default:
		return "journalctl -f"
	}
}

// getDefaultSourceForLogType: 로그 타입별 기본 소스 반환
func (cm *ConnectionManager) getDefaultSourceForLogType(logType, connectionType string) string {
	// 기본적으로 파일 소스 사용
	path := cm.getFilePathExample(logType, connectionType)
	return "file:" + path
}

// getConnectionInfo: 연결 ID로 연결 정보 가져오기
func (cm *ConnectionManager) getConnectionInfo(connectionID string) *ConnectionInfo {
	for i := range cm.config.Connections {
		if cm.config.Connections[i].ID == connectionID {
			return &cm.config.Connections[i]
		}
	}
	return nil
}

// applyCustomLoggingConfig: 커스텀 로깅 설정 적용
func (cm *ConnectionManager) applyCustomLoggingConfig(connectionID string, config *LoggingConfig) bool {
	for i := range cm.config.Connections {
		if cm.config.Connections[i].ID == connectionID {
			cm.config.Connections[i].Logging = config

			// 설정 저장
			if err := cm.SaveConfig(); err != nil {
				util.Log(util.ColorRed, "❌ 커스텀 로깅 설정 저장 실패: %v", err)
				return false
			}

			util.Log(util.ColorGreen, "✅ 커스텀 로깅 설정 적용 완료")
			util.Log(util.ColorCyan, "📋 설정된 로그 타입: %v", config.LogTypes)

			// 설정된 소스들 출력
			for logType, source := range config.LogSources {
				util.Log(util.ColorWhite, "  - %s: %s", logType, source)
			}

			return true
		}
	}
	return false
}

// applyDefaultLoggingConfig: 기본 로깅 설정 적용
func (cm *ConnectionManager) applyDefaultLoggingConfig(connectionID string) bool {
	for i := range cm.config.Connections {
		if cm.config.Connections[i].ID == connectionID {
			if cm.config.Connections[i].Logging != nil {
				cm.config.Connections[i].Logging.Configured = true

				// 설정 저장
				if err := cm.SaveConfig(); err != nil {
					util.Log(util.ColorRed, "❌ 로깅 설정 저장 실패: %v", err)
					return false
				}

				util.Log(util.ColorGreen, "✅ 기본 로깅 설정 적용 완료")
				util.Log(util.ColorCyan, "📋 설정된 로그 타입: %v", cm.config.Connections[i].Logging.LogTypes)
				return true
			}
		}
	}
	return false
}

// GetAvailableLogTypes: 현재 연결의 사용 가능한 로그 타입 반환
func (cm *ConnectionManager) GetAvailableLogTypes() ([]string, error) {
	if cm.currentConnection == nil {
		return nil, fmt.Errorf("현재 연결이 없습니다")
	}

	connectionID := cm.GetCurrentConnectionID()
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		return nil, err
	}

	if !loggingConfig.Configured {
		return nil, fmt.Errorf("로깅 설정이 구성되지 않았습니다")
	}

	return loggingConfig.LogTypes, nil
}

// GetLogSource: 특정 로그 타입의 소스 반환
func (cm *ConnectionManager) GetLogSource(logType string) (string, error) {
	if cm.currentConnection == nil {
		return "", fmt.Errorf("현재 연결이 없습니다")
	}

	connectionID := cm.GetCurrentConnectionID()
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		return "", err
	}

	if !loggingConfig.Configured {
		return "", fmt.Errorf("로깅 설정이 구성되지 않았습니다")
	}

	source, exists := loggingConfig.LogSources[logType]
	if !exists {
		return "", fmt.Errorf("로그 타입 '%s'에 대한 소스를 찾을 수 없습니다", logType)
	}

	return source, nil
}

// ReadLogSource: 로그 소스에서 데이터 읽기 (file: 또는 cmd: 타입별 처리)
func (cm *ConnectionManager) ReadLogSource(logType string) error {
	source, err := cm.GetLogSource(logType)
	if err != nil {
		return err
	}

	if strings.HasPrefix(source, "file:") {
		filePath := strings.TrimPrefix(source, "file:")
		return cm.readLogFile(logType, filePath)
	} else if strings.HasPrefix(source, "cmd:") {
		command := strings.TrimPrefix(source, "cmd:")
		return cm.executeLogCommand(logType, command)
	} else {
		return fmt.Errorf("지원하지 않는 로그 소스 타입: %s", source)
	}
}

// readLogFile: 파일에서 직접 로그 읽기
func (cm *ConnectionManager) readLogFile(logType, filePath string) error {
	if cm.currentConnection == nil {
		return fmt.Errorf("현재 연결이 없습니다")
	}

	util.Log(util.ColorCyan, "📁 [%s] 파일 로그 읽기: %s", logType, filePath)

	// 연결 타입에 따라 파일 읽기 명령어 생성
	var command string
	switch cm.currentConnection.GetType() {
	case "ADB":
		command = fmt.Sprintf("adb shell tail -f %s", filePath)
	case "SSH":
		command = fmt.Sprintf("tail -f %s", filePath)
	default:
		return fmt.Errorf("지원하지 않는 연결 타입: %s", cm.currentConnection.GetType())
	}

	return cm.executeCommand(command)
}

// executeLogCommand: 명령어 실행으로 로그 가져오기
func (cm *ConnectionManager) executeLogCommand(logType, command string) error {
	if cm.currentConnection == nil {
		return fmt.Errorf("현재 연결이 없습니다")
	}

	util.Log(util.ColorCyan, "⚡ [%s] 명령어 로그 실행: %s", logType, command)

	// 연결 타입에 따라 명령어 실행
	var fullCommand string
	switch cm.currentConnection.GetType() {
	case "ADB":
		fullCommand = fmt.Sprintf("adb shell %s", command)
	case "SSH":
		fullCommand = command
	default:
		return fmt.Errorf("지원하지 않는 연결 타입: %s", cm.currentConnection.GetType())
	}

	return cm.executeCommand(fullCommand)
}

// executeCommand: 실제 명령어 실행 (공통 함수)
func (cm *ConnectionManager) executeCommand(command string) error {
	util.Log(util.ColorYellow, "🔧 명령어 실행: %s", command)

	// 여기서 실제 명령어 실행 로직 구현
	// 현재는 로그만 출력
	util.Log(util.ColorGreen, "✅ 명령어 실행 완료")

	return nil
}

func getProjectRoot() (string, error) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("런타임 호출자 정보 가져오기 실패")
	}

	testDir := filepath.Dir(filename)
	// go.mod 파일을 찾기 위해 상위 디렉토리로 이동
	currentDir := testDir
	for {
		if _, err := os.Stat(filepath.Join(currentDir, "go.mod")); err == nil {
			return currentDir, nil
		}
		parentDir := filepath.Dir(currentDir)
		if parentDir == currentDir {
			// 루트 디렉토리에 도달했는데도 찾지 못함
			return "", fmt.Errorf("프로젝트 루트(go.mod)를 찾을 수 없음")
		}
		currentDir = parentDir
	}
}

// ===============================
// 로깅 설정 메뉴 시스템
// ===============================

// ShowLoggingConfigMenu: 로깅 설정 메인 메뉴 표시
func (cm *ConnectionManager) ShowLoggingConfigMenu() error {
	if cm.currentConnection == nil {
		return fmt.Errorf("현재 연결이 없습니다. 먼저 연결을 설정해주세요")
	}

	connectionID := cm.GetCurrentConnectionID()
	if connectionID == "" {
		return fmt.Errorf("현재 연결 정보를 찾을 수 없습니다")
	}

	for {
		// 현재 설정 상태 표시
		cm.displayCurrentLoggingConfig(connectionID)

		// 메뉴 표시
		util.Log(util.ColorCyan, "\n=== 🛠️ 설정 메뉴 ===\n")
		util.Log(util.ColorWhite, "1) 모듈별 로깅 방법 수정/추가\n")
		util.Log(util.ColorWhite, "2) 설정된 모듈 삭제 (로깅 방법만 제거)\n")
		util.Log(util.ColorWhite, "3) 뒤로\n")
		util.Log(util.ColorYellow, "\n선택하세요 (1-3): ")

		choice := cm.getUserInput()

		switch choice {
		case "1":
			cm.editModuleLogging(connectionID)
		case "2":
			cm.deleteModuleLogging(connectionID)
		case "3":
			util.Log(util.ColorCyan, "뒤로 이동합니다.\n")
			return nil
		default:
			util.Log(util.ColorRed, "❌ 잘못된 선택입니다. 다시 선택해주세요.\n")
		}
	}
}

// displayCurrentLoggingConfig: 현재 로깅 설정 상태 표시
func (cm *ConnectionManager) displayCurrentLoggingConfig(connectionID string) {
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		util.Log(util.ColorRed, "❌ 로깅 설정을 가져올 수 없습니다: %v\n", err)
		return
	}

	util.Log(util.ColorCyan, "\n=== 📋 [%s] 로깅 설정 ===\n", connectionID)
	util.Log(util.ColorWhite, "%-15s %-35s\n", "모듈", "로깅 방법")
	util.Log(util.ColorWhite, "%s\n", strings.Repeat("-", 50))

	// 시스템 정의된 모든 모듈에 대해 표시
	for _, module := range SYSTEM_LOG_MODULES {
		source := "(설정 안됨)"
		if loggingConfig.LogSources != nil {
			if moduleSource, exists := loggingConfig.LogSources[module]; exists {
				source = moduleSource
			}
		}

		util.Log(util.ColorWhite, "%-15s %-35s\n", module, source)
	}
}

// checkLogSourceStatus: 로그 소스의 실제 동작 가능성 체크
func (cm *ConnectionManager) checkLogSourceStatus(source string) string {
	if source == "" || source == "미설정" || source == "(설정 안됨)" {
		return "⚠️ 미설정"
	}

	// 연결이 없으면 체크 불가
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return "⚠️ 연결 없음"
	}

	// file: 타입 체크
	if strings.HasPrefix(source, "file:") {
		filePath := strings.TrimPrefix(source, "file:")
		_, err := ExcuteOnShellQuiet(cm, fmt.Sprintf("test -f %s", filePath))
		if err != nil {
			return "❌ 파일 없음"
		}
		return "✅ 파일 존재"
	}

	// cmd: 타입 체크
	if strings.HasPrefix(source, "cmd:") {
		cmdStr := strings.TrimPrefix(source, "cmd:")
		// 명령어의 첫 번째 부분만 체크 (파이프 앞부분)
		firstCmd := strings.Split(cmdStr, "|")[0]
		firstCmd = strings.TrimSpace(firstCmd)

		// which 명령어로 존재 여부 체크
		parts := strings.Fields(firstCmd)
		if len(parts) > 0 {
			_, err := ExcuteOnShellQuiet(cm, fmt.Sprintf("which %s", parts[0]))
			if err != nil {
				return "❌ 명령 없음"
			}
			return "✅ 명령 가능"
		}
	}

	return "❓ 알 수 없음"
}

// displayCurrentLoggingConfigWithStatus: 상태 체크가 포함된 로깅 설정 표시
func (cm *ConnectionManager) displayCurrentLoggingConfigWithStatus(connectionID string) {
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		util.Log(util.ColorRed, "❌ 로깅 설정을 가져올 수 없습니다: %v", err)
		return
	}

	util.Log(util.ColorCyan, "\n=== 📋 [%s] 로깅 설정 ===\n", connectionID)
	util.Log(util.ColorWhite, "%-15s %-35s %-15s\n", "모듈", "소스", "상태")
	util.Log(util.ColorWhite, "%s\n", strings.Repeat("-", 65))

	// 시스템 정의된 모든 모듈에 대해 표시
	for _, module := range SYSTEM_LOG_MODULES {
		source := "미설정"
		if loggingConfig.LogSources != nil {
			if moduleSource, exists := loggingConfig.LogSources[module]; exists {
				source = moduleSource
			}
		}

		// 상태 체크
		status := cm.checkLogSourceStatus(source)

		util.Log(util.ColorWhite, "%-15s %-35s %-15s\n", module, source, status)
	}

	util.Log(util.ColorCyan, "\n💡 연결된 상태에서 실시간 상태 체크가 수행됩니다.\n")
}

// promptModuleSelection: 모듈 선택 공통 함수
func (cm *ConnectionManager) promptModuleSelection() (string, error) {
	util.Log(util.ColorWhite, "수정할 모듈을 선택하세요:\n")
	for i, module := range SYSTEM_LOG_MODULES {
		util.Log(util.ColorWhite, "%d) %s\n", i+1, module)
	}
	util.Log(util.ColorYellow, "선택하세요 (1-%d): ", len(SYSTEM_LOG_MODULES))

	choice := cm.getUserInput()
	moduleIndex, err := strconv.Atoi(choice)
	if err != nil || moduleIndex < 1 || moduleIndex > len(SYSTEM_LOG_MODULES) {
		return "", fmt.Errorf("잘못된 선택입니다")
	}

	return SYSTEM_LOG_MODULES[moduleIndex-1], nil
}

// editModuleLogging: 모듈별 로깅 방법 수정/추가
func (cm *ConnectionManager) editModuleLogging(connectionID string) {
	util.Log(util.ColorCyan, "\n=== 📝 모듈 로깅 방법 수정/추가 ===\n")

	// 공통 모듈 선택 함수 사용
	selectedModule, err := cm.promptModuleSelection()
	if err != nil {
		util.Log(util.ColorRed, "❌ %s\n", err.Error())
		return
	}

	// 현재 연결 정보 가져오기
	connectionInfo := cm.getConnectionInfo(connectionID)
	if connectionInfo == nil {
		util.Log(util.ColorRed, "❌ 연결 정보를 찾을 수 없습니다\n")
		return
	}

	// 해당 모듈의 로깅 방법 설정
	source := cm.promptLogSource(selectedModule, connectionInfo.Type)
	if source == "" {
		util.Log(util.ColorYellow, "⚠️ 설정이 취소되었습니다\n")
		return
	}

	// 설정 업데이트
	cm.updateModuleLogSource(connectionID, selectedModule, source)
}

// deleteModuleLogging: 설정된 모듈 삭제 (로깅 방법만 제거)
func (cm *ConnectionManager) deleteModuleLogging(connectionID string) {
	util.Log(util.ColorCyan, "\n=== 🗑️ 모듈 로깅 방법 삭제 ===\n")

	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		util.Log(util.ColorRed, "❌ 로깅 설정을 가져올 수 없습니다: %v\n", err)
		return
	}

	// 설정된 모듈들만 표시
	var configuredModules []string
	for _, module := range SYSTEM_LOG_MODULES {
		if loggingConfig.LogSources != nil {
			if _, exists := loggingConfig.LogSources[module]; exists {
				configuredModules = append(configuredModules, module)
			}
		}
	}

	if len(configuredModules) == 0 {
		util.Log(util.ColorYellow, "⚠️ 설정된 모듈이 없습니다\n")
		return
	}

	// 삭제할 모듈 선택
	util.Log(util.ColorWhite, "삭제할 모듈을 선택하세요:\n")
	for i, module := range configuredModules {
		source := loggingConfig.LogSources[module]
		util.Log(util.ColorWhite, "%d) %s (%s)\n", i+1, module, source)
	}
	util.Log(util.ColorYellow, "선택하세요 (1-%d): ", len(configuredModules))

	choice := cm.getUserInput()
	moduleIndex, err := strconv.Atoi(choice)
	if err != nil || moduleIndex < 1 || moduleIndex > len(configuredModules) {
		util.Log(util.ColorRed, "❌ 잘못된 선택입니다\n")
		return
	}

	selectedModule := configuredModules[moduleIndex-1]

	// 확인
	util.Log(util.ColorYellow, "정말로 [%s] 모듈의 로깅 설정을 삭제하시겠습니까? (y/n): ", selectedModule)
	confirm := cm.getUserInput()

	if strings.ToLower(confirm) == "y" || strings.ToLower(confirm) == "yes" {
		cm.removeModuleLogSource(connectionID, selectedModule)
		util.Log(util.ColorGreen, "✅ [%s] 모듈의 로깅 설정이 삭제되었습니다\n", selectedModule)
	} else {
		util.Log(util.ColorYellow, "⚠️ 삭제가 취소되었습니다\n")
	}
}

// updateModuleLogSource: 모듈의 로그 소스 업데이트
func (cm *ConnectionManager) updateModuleLogSource(connectionID, module, source string) {
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		util.Log(util.ColorRed, "❌ 로깅 설정을 가져올 수 없습니다: %v", err)
		return
	}

	// LogSources 맵이 없으면 생성
	if loggingConfig.LogSources == nil {
		loggingConfig.LogSources = make(map[string]string)
	}

	// 모듈 소스 업데이트
	loggingConfig.LogSources[module] = source

	// LogTypes에 모듈이 없으면 추가
	moduleExists := false
	for _, logType := range loggingConfig.LogTypes {
		if logType == module {
			moduleExists = true
			break
		}
	}
	if !moduleExists {
		loggingConfig.LogTypes = append(loggingConfig.LogTypes, module)
	}

	// 설정 저장
	err = cm.SetLoggingConfig(connectionID, loggingConfig)
	if err != nil {
		util.Log(util.ColorRed, "❌ 설정 저장 실패: %v\n", err)
	} else {
		util.Log(util.ColorGreen, "✅ [%s] 모듈 로깅 설정이 업데이트되었습니다\n", module)
		util.Log(util.ColorCyan, "   로깅 방법: %s\n", source)
	}
}

// removeModuleLogSource: 모듈의 로그 소스 제거
func (cm *ConnectionManager) removeModuleLogSource(connectionID, module string) {
	loggingConfig, err := cm.GetLoggingConfig(connectionID)
	if err != nil {
		util.Log(util.ColorRed, "❌ 로깅 설정을 가져올 수 없습니다: %v", err)
		return
	}

	// LogSources에서 모듈 제거
	if loggingConfig.LogSources != nil {
		delete(loggingConfig.LogSources, module)
	}

	// LogTypes에서도 모듈 제거
	newLogTypes := []string{}
	for _, logType := range loggingConfig.LogTypes {
		if logType != module {
			newLogTypes = append(newLogTypes, logType)
		}
	}
	loggingConfig.LogTypes = newLogTypes

	// 설정 저장
	err = cm.SetLoggingConfig(connectionID, loggingConfig)
	if err != nil {
		util.Log(util.ColorRed, "❌ 설정 저장 실패: %v\n", err)
	}
}
