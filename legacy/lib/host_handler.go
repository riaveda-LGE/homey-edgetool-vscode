package lib

import (
	"fmt"
	"strings"

	"edgetool/util"
)

// HostHandler는 호스트 연결 명령어를 처리합니다
type HostHandler struct {
	BaseHandler
}

// NewHostHandler는 새로운 HostHandler 인스턴스를 생성합니다
func NewHostHandler() *HostHandler {
	return &HostHandler{}
}

func (h *HostHandler) Execute(cm *ConnectionManager, args string) error {
	// 연결 상태 확인
	if cm.currentConnection == nil || !cm.currentConnection.IsConnected() {
		return fmt.Errorf("연결이 설정되어 있지 않거나 연결되어 있지 않습니다. 먼저 연결을 설정하세요")
	}

	args = strings.TrimSpace(args)
	if args == "" {
		util.Log("사용법: host <명령어>\n")
		util.Log("참고: 파일 전송은 git push/git pull 명령어를 사용하세요\n")
		return nil
	}

	// 바로 명령어 실행 (cmd 서브커맨드 제거)
	out, err := ExcuteOnShell(cm, args)
	if err != nil {
		util.Log(util.ColorRed, "명령 실행 오류: %v\n", err)
		if out != "" {
			util.Log(out)
		}
		return err
	} else {
		util.Log(out)
	}

	return nil
}
