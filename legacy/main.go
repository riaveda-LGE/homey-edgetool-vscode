package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"edgetool/lib"  // lib 패키지 import
	"edgetool/util" // util 패키지 import
)

// DEFAULT_WORKSPACE_DIR_PATHS는 pkg 패키지에서 가져옴
var DEFAULT_WORKSPACE_DIR_PATHS = lib.DEFAULT_WORKSPACE_DIR_PATHS

func main() {
	// 명령줄 인자 파싱
	noConnection := false
	for _, arg := range os.Args[1:] {
		if arg == "--no-connection" {
			noConnection = true
			break
		}
	}

	// Workspace 초기화 및 작업 디렉토리 변경
	initializeWorkspaceAndChdir()

	// ConnectionManager 생성
	cm := lib.NewConnectionManager()

	// 연결 설정 (--no-connection 플래그가 없으면 연결 설정)
	if !noConnection {
		err := cm.SetupConnection()
		if err != nil {
			util.Log(util.ColorRed, "연결 설정 실패: %v\n", err)
			util.Log("연결 없이 프로그램을 계속 사용합니다.\n")
		}
	} else {
		util.Log(util.ColorCyan, "연결 없이 프로그램을 시작합니다.\n")
	}

	// 핸들러들 초기화
	gitHandler := lib.NewGitHandler()
	homeyHandler := lib.NewHomeyHandler()
	hostHandler := lib.NewHostHandler()
	etcHandler := lib.NewETCHandler()
	loggingHandler := lib.NewLoggingHandler()

	util.Log(util.ColorGreen, "명령어 핸들러 초기화 완료\n")

	// 메인 루프
	reader := bufio.NewReader(os.Stdin)
	for {
		util.Log(util.ColorBrightGreen, "\nedge> ")
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)

		if input == "" {
			continue
		}

		parts := strings.Fields(input)
		command := parts[0]

		// 나머지 명령어들을 args로 결합
		args := ""
		if len(parts) > 1 {
			args = strings.Join(parts[1:], " ")
		}

		// ===== 명령어 라우팅 (모든 분기가 여기서 명확하게 보임) =====
		var err error
		switch command {
		// 시스템 명령어
		case "quit", "q", "exit", "ㅂ":
			util.Log("프로그램을 종료합니다...\n")
			// 모든 핸들러의 리소스 정리
			gitHandler.Cleanup()
			homeyHandler.Cleanup()
			hostHandler.Cleanup()
			etcHandler.Cleanup()
			util.Log("종료합니다.\n")
			return
		case "help", "h":
			showHelp()
			continue

		// Git 명령어
		case "git":
			err = gitHandler.Execute(cm, args)

		// Homey 명령어 (개별 명령어로 분리)
		case "homey-restart", "hr":
			err = homeyHandler.Restart(cm)
		case "homey-unmount":
			err = homeyHandler.Unmount(cm)
		case "homey-mount":
			// mount 명령어의 옵션 파싱
			if args == "" {
				util.Log(util.ColorRed, "mount 옵션이 필요합니다: --list, pro, core, sdk, bridge\n")
				continue
			}
			err = homeyHandler.Mount(cm, args)
		case "homey-logging", "hl":
			// 시스템 로그 [filter] 명령어
			// logging 명령어 검증 및 분기
			if args == "" {
				// 옵션 없음: 실시간 스트림 모드
				_, err = homeyHandler.LoggingSimple(cm, args)
			} else if strings.HasPrefix(args, "--dir") {
				// 올바른 옵션: --dir (로컬 파일 통합 모드)
				dirArgs := strings.Fields(args)
				if len(dirArgs) < 2 {
					util.Log(util.ColorRed, "❌ logging --dir 명령어 사용법: logging --dir <디렉토리_경로>\n")
					util.Log(util.ColorCyan, "  예시: logging --dir ./logs/\n")
					continue
				}
				directory := dirArgs[1]
				err = loggingHandler.HandleLogViewer(directory)
			} else {
				// 잘못된 옵션: -dir, --wrong 등
				util.Log(util.ColorRed, "❌ 잘못된 옵션입니다: '%s'\n", args)
				util.Log(util.ColorCyan, "  지원되는 옵션:\n")
				util.Log(util.ColorCyan, "    (옵션 없음)    : 실시간 로그 스트리밍\n")
				util.Log(util.ColorCyan, "    --dir <경로>   : 로컬 로그 파일 통합\n")
				util.Log(util.ColorCyan, "  예시:\n")
				util.Log(util.ColorCyan, "    logging                    # 실시간 모드\n")
				util.Log(util.ColorCyan, "    logging --dir ./logs/     # 로컬 파일 모드\n")
				continue
			}
		case "homey-enable-devtoken":
			err = homeyHandler.EnableDevToken(cm)
		case "homey-disable-devtoken":
			err = homeyHandler.DisableDevToken(cm)
		case "homey-enable-app-log":
			err = homeyHandler.EnableAppLog(cm)
		case "homey-disable-app-log":
			err = homeyHandler.DisableAppLog(cm)
		case "homey-update":
			// update 명령어 파싱: homey-update <image_path> <temp_path>
			if args == "" {
				util.Log(util.ColorRed, "homey-update 명령어 사용법: homey-update <이미지_파일_경로> <임시_경로>\n")
				util.Log(util.ColorCyan, "  예시: homey-update ./homey-image.tar.gz /tmp/\n")
				continue
			}
			updateArgs := strings.Fields(args)
			if len(updateArgs) != 2 {
				util.Log(util.ColorRed, "homey-update 명령어는 이미지 파일 경로와 임시 경로 2개의 인자가 필요합니다\n")
				util.Log(util.ColorCyan, "  사용법: homey-update <이미지_파일_경로> <임시_경로>\n")
				util.Log(util.ColorCyan, "  예시: homey-update ./homey-image.tar.gz /tmp/\n")
				continue
			}
			err = homeyHandler.UpdateHomey(cm, updateArgs[0], updateArgs[1])
		// 기존 명령어들 (deprecated 경고와 함께 유지)
		case "unmount":
			util.Log(util.ColorYellow, "⚠️ 'unmount'는 deprecated되었습니다. 앞으로 'homey-unmount'를 사용하세요.\n")
			continue
		case "mount":
			util.Log(util.ColorYellow, "⚠️ 'mount'는 deprecated되었습니다. 앞으로 'homey-mount'를 사용하세요.\n")
			continue
		case "logging":
			util.Log(util.ColorYellow, "⚠️ 'logging'는 deprecated되었습니다. 앞으로 'homey-logging'를 사용하세요.\n")
			continue
		case "enable-devtoken":
			util.Log(util.ColorYellow, "⚠️ 'enable-devtoken'는 deprecated되었습니다. 앞으로 'homey-enable-devtoken'를 사용하세요.\n")
			err = homeyHandler.EnableDevToken(cm)
		case "disable-devtoken":
			util.Log(util.ColorYellow, "⚠️ 'disable-devtoken'는 deprecated되었습니다. 앞으로 'homey-disable-devtoken'를 사용하세요.\n")
			err = homeyHandler.DisableDevToken(cm)
		case "enable-app-log":
			util.Log(util.ColorYellow, "⚠️ 'enable-app-log'는 deprecated되었습니다. 앞으로 'homey-enable-app-log'를 사용하세요.\n")
			err = homeyHandler.EnableAppLog(cm)
		case "disable-app-log":
			util.Log(util.ColorYellow, "⚠️ 'disable-app-log'는 deprecated되었습니다. 앞으로 'homey-disable-app-log'를 사용하세요.\n")
			err = homeyHandler.DisableAppLog(cm)

		// 일반 명령어
		case "shell":
			err = etcHandler.Shell(cm)
		case "server":
			err = etcHandler.Server(cm, args)

		// Host 명령어
		case "host":
			if len(args) > 0 {
				hostArgs := strings.Fields(args)
				if len(hostArgs) > 0 && (hostArgs[0] == "pull" || hostArgs[0] == "push") {
					// 기존 host pull/push는 새로운 구조로 안내
					showNewCommandGuide(hostArgs[0], "host", strings.Join(hostArgs[1:], " "))
					continue
				} else {
					// 기존 host 명령어는 hostHandler로 처리
					err = hostHandler.Execute(cm, args)
				}
			} else {
				err = hostHandler.Execute(cm, args)
			}
		// 연결 관리 명령어
		case "connect_change", "cc":
			err = cm.SwitchConnection()

		case "connect_info", "ci":
			cm.GetConnectionInfo()

		// 알 수 없는 명령어
		default:
			util.Log(util.ColorRed, "알 수 없는 명령어: %s\n", command)
			util.Log("도움말: help\n")
			continue
		}

		// 에러 처리
		if err != nil {
			util.Log(util.ColorRed, "오류: %v\n", err)
		}
	}
}

func initializeWorkspaceAndChdir() {
	workspacePath := "./workspace"

	// workspace 폴더가 없으면 생성
	if _, err := os.Stat(workspacePath); os.IsNotExist(err) {
		err := os.MkdirAll(workspacePath, 0755)
		if err != nil {
			util.Log(util.ColorRed, "workspace 폴더 생성 실패: %v\n", err)
			return
		}
	}

	// 작업 디렉토리 변경
	if err := os.Chdir(workspacePath); err != nil {
		util.Log(util.ColorRed, "작업 디렉토리 변경 실패: %v\n", err)
	} else {
		util.Log(util.ColorBlue, "작업 디렉토리 변경: %s\n", workspacePath)
	}

	// 기본 작업 폴더들 초기화
	initializeWorkspaceDirectories()

	// workspace에 git이 없으면 초기화
	if !isGitRepository(".") {
		if err := initializeGitInWorkspace("."); err != nil {
			util.Log(util.ColorRed, "workspace git 초기화 실패: %v\n", err)
		}
	}
}

func initializeWorkspaceDirectories() {

	for _, dirPath := range DEFAULT_WORKSPACE_DIR_PATHS {
		// 폴더가 존재하지 않으면 생성
		if _, err := os.Stat(dirPath); os.IsNotExist(err) {
			err := os.MkdirAll(dirPath, 0755)
			if err != nil {
				util.Log(util.ColorRed, "폴더 생성 실패: %s (%v)\n", dirPath, err)
			}
		}
	}
}

func isGitRepository(path string) bool {
	// .git 폴더 존재 확인
	gitPath := filepath.Join(path, ".git")
	_, err := os.Stat(gitPath)
	return !os.IsNotExist(err)
}

func initializeGitInWorkspace(workspacePath string) error {
	// workspace에서 git init 실행
	cmd := exec.Command("git", "init")
	cmd.Dir = workspacePath
	return cmd.Run()
}

func showNewCommandGuide(action, target, option string) {
	util.Log(util.ColorYellow, "⚠️  명령어 구조가 변경되었습니다!\n")
	util.Log("\n")
	util.Log(util.ColorBrightGreen, "💡 새로운 명령어 구조:\n")
	util.Log("  git pull <option>     - 파일 다운로드 (pro/core/sdk/bridge/host <path>)\n")
	util.Log("  git push <option>     - 파일 업로드 (pro/core/sdk/bridge/host <path>)\n")
	util.Log("\n")
}

func showHelp() {
	util.Log(util.ColorCyan, "Host 관리:\n")
	util.Log("  %-35s %s\n", "host <command>", "호스트 명령 실행, ex): host ls -al /user")
	util.Log("  %-35s %s\n", "connect_change, cc", "호스트 연결 변경")
	util.Log("  %-35s %s\n", "connect_info, ci", "현재 연결 정보")
	util.Log("  %-35s %s\n", "shell", "ADB shell 접속 (ADB 연결 시에만)")
	util.Log("\n")
	util.Log(util.ColorCyan, "Homey 관리:\n")
	util.Log("  %-35s %s\n", "homey-restart, hr", "Homey 서비스 재시작")
	util.Log("  %-35s %s\n", "homey-mount <option>", "Homey 볼륨 마운트 (--list/pro/core/sdk/bridge)")
	util.Log("  %-35s %s\n", "homey-unmount", "Homey 언마운트")
	util.Log("  %-35s %s\n", "homey-logging [filter]", "시스템 실시간 로그 (필터링 가능)")
	util.Log("  %-35s %s\n", "logging --dir <path>", "로컬 로그 파일 통합 뷰어")
	util.Log("  %-35s %s\n", "", "  - ex)logging --dir ./logs/")
	util.Log("  %-35s %s\n", "homey-update <img> <host_path>", "Homey Docker 이미지 업데이트")
	util.Log("  %-35s %s\n", "", "  - ex)homey-update C:\\Users\\User\\Downloads\\homey-image.tar.gz /user/")
	util.Log("  %-35s %s\n", "homey-enable-devtoken", "session 토큰 활성화")
	util.Log("  %-35s %s\n", "homey-disable-devtoken", "session 토큰 비활성화")
	util.Log("  %-35s %s\n", "homey-enable-app-log", "앱 로그 콘솔 출력 활성화")
	util.Log("  %-35s %s\n", "homey-disable-app-log", "앱 로그 콘솔 출력 비활성화")
	util.Log("\n")
	util.Log(util.ColorCyan, "Git 기반 동기화:\n")
	util.Log("  %-35s %s\n", "git pull <repository>", "파일 다운로드 (pro/core/sdk/bridge/host <path>)")
	util.Log("  %-35s %s\n", "", "  - pull host: 로컬 경로는 ./host_sync/ 아래 자동 생성")
	util.Log("  %-35s %s\n", "git push", "모든 커밋의 변경된 파일을 분석하여 push")
	util.Log("  %-35s %s\n", "", "  - [Do not push] 커밋은 자동 제외")
	util.Log("  %-35s %s\n", "", "  - 파일 경로로 <repository> 자동 분류 (pro/core/sdk/bridge/host)")
	util.Log("  %-35s %s\n", "git push {commit_id}", "HEAD부터 {commit_id}까지의 파일들을 push")
	util.Log("  %-35s %s\n", "git push {filename}", "특정 파일만 push (경로로 카테고리 자동 분석)")
	util.Log("  %-35s %s\n", "", "  - ex)git push homey_pro/_data/lib/App.mjs")
	util.Log("\n")
	util.Log(util.ColorCyan, "그외:\n")
	util.Log("  %-35s %s\n", "help, h", "도움말 표시")
	util.Log("  %-35s %s\n", "quit, q, exit", "프로그램 종료")
}
