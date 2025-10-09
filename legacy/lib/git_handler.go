package lib

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"edgetool/util"
)

// GitHandler는 Git 명령어와 모든 동기화 작업을 처리합니다
// 모든 git 명령어는 workspace 폴더 안에서 실행됩니다
type GitHandler struct {
	BaseHandler
}

// PullOptions는 pull 명령어의 옵션을 정의합니다
type PullOptions struct {
	SkipCommit    bool   // true면 commit 생략
	CommitMessage string // 커스텀 커밋 메시지 (빈 문자열이면 기본 메시지 사용)
	LocalPath     string // 사용자 지정 로컬 다운로드 경로 (빈 문자열이면 기본 ./host_sync 사용)
}

// PushOptions는 push 명령어의 옵션을 정의합니다
type PushOptions struct {
	HostPath string // 사용자 지정 호스트 업로드 경로 (빈 문자열이면 기본 /tmp 사용)
}

// CommitResult는 비동기 git commit 결과를 담는 구조체입니다
type CommitResult struct {
	Error     error
	Duration  time.Duration
	FileCount int
	Message   string
}

// NewGitHandler는 새로운 GitHandler 인스턴스를 생성합니다
func NewGitHandler() *GitHandler {
	return &GitHandler{}
}

// Execute는 git 명령어를 처리합니다 (git pull/push 포함)
func (h *GitHandler) Execute(cm *ConnectionManager, args string) error {
	args = strings.TrimSpace(args)
	if args == "" {
		util.Log("사용법: git <git_command>\n")
		util.Log("예: git status, git add ., git commit -m \"message\"\n")
		util.Log("Git 기반 동기화: git pull <option>, git push [commit_id|filename]\n")
		return nil
	}

	// git pull/push 명령어를 새로운 구조로 처리
	gitArgs := strings.Fields(args)
	if len(gitArgs) > 0 {
		subCommand := gitArgs[0]
		remainingArgs := ""
		if len(gitArgs) > 1 {
			remainingArgs = strings.Join(gitArgs[1:], " ")
		}
		
		if subCommand == "pull" {
			// git pull 옵션 파싱
			opts := &PullOptions{}
			pullArgs := strings.Fields(remainingArgs)
			
			// -l/--local 옵션 찾기
			for i := 0; i < len(pullArgs); i++ {
				if (pullArgs[i] == "-l" || pullArgs[i] == "--local") && i+1 < len(pullArgs) {
					opts.LocalPath = pullArgs[i+1]
					// 옵션과 값 제거
					pullArgs = append(pullArgs[:i], pullArgs[i+2:]...)
					break
				}
			}
			
			// 옵션이 제거된 args로 HandlePull 호출
			cleanArgs := strings.Join(pullArgs, " ")
			return h.HandlePull(cm, cleanArgs, opts)
		}
		
		if subCommand == "push" {
			// git push 옵션 파싱
			opts := &PushOptions{}
			pushArgs := strings.Fields(remainingArgs)
			
			// -h/--host 옵션 찾기
			for i := 0; i < len(pushArgs); i++ {
				if (pushArgs[i] == "-h" || pushArgs[i] == "--host") && i+1 < len(pushArgs) {
					opts.HostPath = pushArgs[i+1]
					// 옵션과 값 제거
					pushArgs = append(pushArgs[:i], pushArgs[i+2:]...)
					break
				}
			}
			
			// 옵션이 제거된 args로 HandleGitPush 호출
			cleanArgs := strings.Join(pushArgs, " ")
			return h.HandleGitPush(cm, cleanArgs, opts)
		}
	}

	// 일반 git 명령어 처리
	shouldExecute := true

	// --amend 옵션 처리: 새로운 터미널 창에서 실행
	if strings.Contains(args, "commit") && strings.Contains(args, "--amend") {
		util.Log(util.ColorCyan, "git commit --amend를 새로운 CMD 창에서 실행합니다...\n")
		util.Log(util.ColorYellow, "터미널 창이 열리면 --amend 작업을 완료한 후 창을 닫아주세요.\n")
		return h.executeGitAmendInTerminal(args)
	}

	// git commit -m 뒤에 메시지가 없는 경우 처리 금지
	if shouldExecute && strings.Contains(args, "commit") && strings.Contains(args, "-m") {
		parts := strings.Fields(args)
		for i, part := range parts {
			if part == "-m" {
				if i+1 >= len(parts) || strings.TrimSpace(parts[i+1]) == "" {
					return fmt.Errorf("git commit -m requires a commit message")
				}
				break
			}
		}
	}

	// git commit만 입력된 경우 터미널 창에서 실행
	if shouldExecute && args == "commit" {
		util.Log(util.ColorYellow, "터미널 창이 열리면 커밋 메시지를 입력하고 작업을 완료한 후 창을 닫아주세요.\n")
		return h.executeCommandInTerminal("git commit", "git commit")
	}

	if shouldExecute {
		// git status 명령어는 색상 구분해서 표시
		if args == "status" {
			return h.displayGitStatusWithColors()
		}
		
		gitCmd := "git " + args
		output, err := ExecuteShellCommand(gitCmd, 30*time.Second)
		if err != nil {
			return fmt.Errorf("git 명령 실행 오류: %v", output)
		}
	}

	return nil
}

// HandlePull은 pull 명령어를 처리합니다
func (h *GitHandler) HandlePull(cm *ConnectionManager, args string, opts *PullOptions) error {
	if args == "" {
		return fmt.Errorf("pull 옵션이 필요합니다: pro, core, sdk, bridge, host <path>")
	}

	parts := strings.Fields(args)
	if len(parts) == 0 {
		return fmt.Errorf("pull 옵션이 필요합니다")
	}

	// 모든 pull 명령어는 단일 옵션만 허용
	if len(parts) > 2 {
		return fmt.Errorf("pull 명령어는 단일 옵션만 지원합니다. 사용법: pull <option>")
	}

	option := parts[0]

	// pull host <path>인 경우
	if option == "host" {
		if len(parts) < 2 {
			return fmt.Errorf("host 경로가 필요합니다")
		}
		hostPath := parts[1]
		return h.pullHost(cm, hostPath, opts)
	}

	// pull <option>인 경우 (pro, core, sdk, bridge)
	switch option {
	case "pro", "core", "sdk", "bridge":
		return h.pullHomey(cm, option, opts)
	default:
		return fmt.Errorf("지원하지 않는 pull 옵션: %s (pro, core, sdk, bridge, host <path>)", option)
	}
}

// HandleGitPush는 git push 명령어를 처리합니다
// 사용법: 
//   git push                    - 모든 커밋의 변경된 파일을 분석하여 push
//   git push {option} {file}    - 명시적 카테고리로 특정 파일 push (pro/core/sdk/bridge/host)
//   git push {commit_id}        - HEAD부터 특정 커밋까지의 변경된 파일을 push
//   git push {filename}         - 특정 파일만 push (경로로 카테고리 자동 분석)
func (h *GitHandler) HandleGitPush(cm *ConnectionManager, localFilePath string, opts *PushOptions) error {
	if localFilePath == "" {
		// git push (모든 커밋)
		return h.pushAllCommits(cm)
	}
	
	// 단일 인자의 경우: 커밋 ID인지 파일명인지 확인
	if h.isCommitId(localFilePath) {
		// git push {commit_id}
		return h.pushCommitRange(cm, localFilePath)
	} else {
		// git push {filename}
		return h.pushSpecificFile(cm, localFilePath, opts)
	}
}

// pushAllCommits는 모든 커밋의 변경된 파일을 분석하여 push합니다
func (h *GitHandler) pushAllCommits(cm *ConnectionManager) error {
	util.Log(util.ColorCyan, "모든 커밋의 변경된 파일을 분석합니다...\n")
	
	files, err := h.getAllCommitFiles()
	if err != nil {
		return fmt.Errorf("커밋 파일 분석 실패: %v", err)
	}
	
	if len(files) == 0 {
		util.Log(util.ColorYellow, "Push할 파일이 없습니다.\n")
		return nil
	}
	
	return h.pushFilesByCategory(cm, files, nil)
}

// pushCommitRange는 HEAD부터 특정 커밋까지의 변경된 파일을 push합니다
func (h *GitHandler) pushCommitRange(cm *ConnectionManager, commitId string) error {
	util.Log(util.ColorCyan, "HEAD부터 커밋 %s까지의 변경된 파일을 분석합니다...\n", commitId)
	
	files, err := h.getCommitRangeFiles(commitId)
	if err != nil {
		return fmt.Errorf("커밋 범위 파일 분석 실패: %v", err)
	}
	
	if len(files) == 0 {
		util.Log(util.ColorYellow, "Push할 파일이 없습니다.\n")
		return nil
	}
	
	return h.pushFilesByCategory(cm, files, nil)
}

// pushSpecificFile은 특정 파일만 push합니다
func (h *GitHandler) pushSpecificFile(cm *ConnectionManager, filename string, opts *PushOptions) error {
	util.Log(util.ColorCyan, "특정 파일을 push합니다: %s\n", filename)

	if opts != nil && opts.HostPath != "" {
		// HostPath 옵션이 명시되어 있으면 직접 pushHostFile 호출 (옵션 우선)
		return h.pushHostFile(cm, filename, opts)
	} else {
		// HostPath 옵션이 없으면 기존 방식대로 pushFilesByCategory 호출
		files := []string{filename}
		return h.pushFilesByCategory(cm, files, opts)
	}
}

// getAllCommitFiles는 모든 커밋에서 변경된 파일 목록을 가져옵니다 (다운로드 커밋 제외)
func (h *GitHandler) getAllCommitFiles() ([]string, error) {
	// git log --pretty=format:"%H %s" --name-only
	cmd := exec.Command("git", "log", "--pretty=format:%H %s", "--name-only")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git log 실행 실패: %v", err)
	}
	
	return h.parseCommitFiles(string(output))
}

// getCommitRangeFiles는 HEAD부터 특정 커밋까지의 변경된 파일 목록을 가져옵니다
func (h *GitHandler) getCommitRangeFiles(commitId string) ([]string, error) {
	// git log --pretty=format:"%H %s" --name-only HEAD...{commitId}
	cmd := exec.Command("git", "log", "--pretty=format:%H %s", "--name-only", fmt.Sprintf("HEAD...%s", commitId))
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git log 범위 실행 실패: %v", err)
	}
	
	return h.parseCommitFiles(string(output))
}

// parseCommitFiles는 git log 출력을 파싱하여 파일 목록을 추출합니다
func (h *GitHandler) parseCommitFiles(logOutput string) ([]string, error) {
	lines := strings.Split(strings.TrimSpace(logOutput), "\n")
	files := make(map[string]bool) // 중복 제거용
	
	var currentCommitMsg string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		
		// 커밋 라인인지 확인 (SHA + 메시지)
		if h.isCommitLine(line) {
			// 커밋 메시지 추출
			parts := strings.SplitN(line, " ", 2)
			if len(parts) >= 2 {
				currentCommitMsg = parts[1]
			}
			continue
		}
		
		// 파일 라인인 경우
		if currentCommitMsg != "" && !h.shouldSkipCommit(currentCommitMsg) {
			files[line] = true
		}
	}
	
	// map을 slice로 변환
	result := make([]string, 0, len(files))
	for file := range files {
		result = append(result, file)
	}
	
	return result, nil
}

// isCommitLine은 라인이 커밋 라인인지 확인합니다
func (h *GitHandler) isCommitLine(line string) bool {
	parts := strings.Fields(line)
	if len(parts) < 2 {
		return false
	}
	
	// 첫 번째 부분이 SHA인지 확인 (40자 헥스)
	sha := parts[0]
	if len(sha) >= 7 && len(sha) <= 40 {
		// 헥스 문자만 포함하는지 확인
		for _, c := range sha {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
		return true
	}
	
	return false
}

// shouldSkipCommit은 커밋을 건너뛸지 결정합니다
func (h *GitHandler) shouldSkipCommit(commitMsg string) bool {
	// "[Do not push]"로 시작하는 다운로드 커밋은 제외
	for _, skipMsg := range SKIP_COMMIT_MESSAGES {
		if commitMsg == skipMsg {
			return true
		}
	}
	
	return false
}

// pushFilesByCategory는 파일들을 카테고리별로 분류하여 push합니다
func (h *GitHandler) pushFilesByCategory(cm *ConnectionManager, files []string, opts *PushOptions) error {
	categories := map[string][]string{
		"pro":    {},
		"core":   {},
		"sdk":    {},
		"bridge": {},
		"host":   {},
	}
	
	// 파일들을 카테고리별로 분류
	for _, file := range files {
		category := h.getFileCategory(file)
		if category != "unknown" {
			categories[category] = append(categories[category], file)
		}
	}
	
	// 각 카테고리별로 push 실행
	totalPushed := 0
	for category, categoryFiles := range categories {
		if len(categoryFiles) == 0 {
			continue
		}
		
		util.Log(util.ColorCyan, "\n=== %s 카테고리 파일 push (총 %d개) ===\n", category, len(categoryFiles))
		
		if category == "host" {
			// host 파일들은 개별적으로 push
			for _, file := range categoryFiles {
				if err := h.pushHostFile(cm, file, opts); err != nil {
					util.Log(util.ColorRed, "Host 파일 push 실패: %s, %v\n", file, err)
				} else {
					totalPushed++
				}
			}
		} else {
			// homey 파일들은 카테고리별로 batch push
			for _, file := range categoryFiles {
				if err := h.pushHomeyFile(cm, category, file); err != nil {
					util.Log(util.ColorRed, "Homey %s 파일 push 실패: %s, %v\n", category, file, err)
				} else {
					totalPushed++
				}
			}
		}
	}
	
	util.Log(util.ColorBrightGreen, "\n✅ Git push 완료: 총 %d개 파일이 성공적으로 push되었습니다.\n", totalPushed)
	return nil
}

// getFileCategory는 파일 경로를 분석하여 카테고리를 반환합니다
func (h *GitHandler) getFileCategory(filePath string) string {
	// 파일 경로에서 카테고리 추출
	if strings.Contains(filePath, DIR_HOMEY_PRO) {
		return "pro"
	} else if strings.Contains(filePath, DIR_HOMEY_CORE) {
		return "core"
	} else if strings.Contains(filePath, DIR_HOMEY_SDK) {
		return "sdk"
	} else if strings.Contains(filePath, DIR_HOMEY_BRIDGE) {
		return "bridge"
	} else if strings.Contains(filePath, DIR_HOST_SYNC) {
		return "host"
	}
	
	return "unknown"
}

// isCommitId는 문자열이 커밋 ID인지 확인합니다
func (h *GitHandler) isCommitId(str string) bool {
	// 길이 체크 (최소 7자, 최대 40자)
	if len(str) < 7 || len(str) > 40 {
		return false
	}
	
	// 헥스 문자만 포함하는지 확인
	for _, c := range str {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	
	// git cat-file로 실제 커밋인지 확인
	cmd := exec.Command("git", "cat-file", "-e", str)
	return cmd.Run() == nil
}

// executeGitAmendInTerminal은 git commit --amend를 새로운 터미널 창에서 실행하고 완료를 기다립니다
func (h *GitHandler) executeGitAmendInTerminal(args string) error {
	// git commit --amend의 경우 staging 파일이 없어도 실행 가능하므로 상태 확인 생략
	// git 상태 먼저 확인 (선택적)
	if err := h.checkGitStatusForAmend(); err != nil {
		util.Log(util.ColorYellow, "경고: %v\n", err)
		util.Log(util.ColorCyan, "계속 진행합니다...\n")
	}

	// git 명령어 구성
	gitCmd := "git " + args

	// 공통 함수로 터미널 실행
	return h.executeCommandInTerminal(gitCmd, "git commit --amend")
}

// pullHomey는 Homey 옵션별 Pull을 구현합니다
func (h *GitHandler) pullHomey(cm *ConnectionManager, option string, opts *PullOptions) error {
	// Docker data root 경로 동적 조회
	dockerDataRoot, err := h.getDockerDataRoot(cm)
	if err != nil {
		util.Log(util.ColorYellow, "Docker data root 조회 실패, 기본 경로 사용: %v\n", err)
		dockerDataRoot = "/lg_rw/var/lib/docker" // fallback
	}
	
	// 상대 경로 맵 (Docker data root를 제외한 부분)
	relativePaths := map[string]string{
		"pro":    "/volumes/homey-app/_data",
		"core":   "/volumes/homey-node/_data/@athombv/homey-core/dist",
		"sdk":    "/volumes/homey-node/_data/@athombv/homey-apps-sdk-v3",
		"bridge": "/volumes/homey-node/_data/@athombv/homey-bridge",
	}
	
	// workspace 폴더 안의 로컬 디렉토리 경로
	localPaths := map[string]string{
		"pro":    "./" + DIR_HOMEY_PRO,    // workspace/homey_pro
		"core":   "./" + DIR_HOMEY_CORE,   // workspace/homey_core
		"sdk":    "./" + DIR_HOMEY_SDK,    // workspace/homey-apps-sdk-v3
		"bridge": "./" + DIR_HOMEY_BRIDGE, // workspace/homey-bridge
	}
	
	messages := map[string]string{
		"pro":    MSG_DOWNLOAD_HOMEY_PRO,
		"core":   MSG_DOWNLOAD_HOMEY_CORE,
		"sdk":    MSG_DOWNLOAD_HOMEY_SDK,
		"bridge": MSG_DOWNLOAD_HOMEY_BRIDGE,
	}
	
	// 최종 호스트 경로 생성
	hostPath := dockerDataRoot + relativePaths[option]
	localPath := localPaths[option]
	
	util.Log(util.ColorCyan, "Homey %s 다운로드를 시작합니다...\n", option)
	
	// 1. 로컬 디렉토리 생성
	if err := os.MkdirAll(localPath, 0755); err != nil {
		return fmt.Errorf("로컬 디렉토리 생성 실패: %v", err)
	}
	
	// 2. 파일 다운로드 (기존 PullFile 함수 활용 - ADB/SSH 자동 처리)
	util.Log(util.ColorCyan, "파일 다운로드 중: %s -> %s\n", hostPath, localPath)
	if err := PullFileWithProgress(cm, hostPath, localPath); err != nil {
		return fmt.Errorf("파일 다운로드 실패: %v", err)
	}
	
	util.Log(util.ColorGreen, "파일 다운로드 완료!\n")
	
	// 3. Git add 및 commit (옵션에 따라 생략 가능)
	if opts == nil || !opts.SkipCommit {
		util.Log(util.ColorCyan, "Git commit을 시작합니다...\n")
		commitChan := h.gitCommitAsync(messages[option])
		
		// commit 완료 대기
		result := <-commitChan
		if result.Error != nil {
			util.Log(util.ColorYellow, "Git commit 실패 (파일은 정상 다운로드됨): %v\n", result.Error)
		} else {
			util.Log(util.ColorGreen, "Git commit 완료: %s (%.2fs, %d개 파일)\n", 
				result.Message, result.Duration.Seconds(), result.FileCount)
		}
	} else {
		util.Log(util.ColorCyan, "옵션에 따라 Git commit을 생략합니다.\n")
	}
	
	util.Log(util.ColorBrightGreen, "✅ Homey %s 다운로드 완료!\n", option)
	return nil
}

// pullHost는 Host Pull을 구현합니다
func (h *GitHandler) pullHost(cm *ConnectionManager, hostPath string, opts *PullOptions) error {
	// 1. 경로 유효성 검사 (배치 파일과 동일)
	if !strings.HasPrefix(hostPath, "/") {
		return fmt.Errorf("호스트 경로는 절대경로로 시작해야 합니다. (/ 로 시작)")
	}
	
	util.Log(util.ColorCyan, "Host 경로 다운로드를 시작합니다: %s\n", hostPath)
	
	// 2. 호스트에서 파일 존재 확인
	exists, err := h.checkHostPathExists(cm, hostPath)
	if err != nil {
		return fmt.Errorf("호스트 경로 확인 실패: %v", err)
	}
	if !exists {
		return fmt.Errorf("호스트에 경로가 존재하지 않습니다: %s", hostPath)
	}
	
	// 3. 파일/디렉토리 타입 확인
	fileType, err := h.getHostFileType(cm, hostPath)
	if err != nil {
		return fmt.Errorf("파일 타입 확인 실패: %v", err)
	}
	
	// 4. 로컬 경로 생성
	var localPath string
	if opts != nil && opts.LocalPath != "" {
		localPath = opts.LocalPath
	} else {
		localPath = h.convertToLocalPath(hostPath)
	}
	
	if fileType == "FILE" {
		// 단일 파일 다운로드
		if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
			return fmt.Errorf("로컬 디렉토리 생성 실패: %v", err)
		}
		
		util.Log(util.ColorCyan, "파일 다운로드 중: %s -> %s\n", hostPath, localPath)
		if err := PullFileWithProgress(cm, hostPath, localPath); err != nil {
			return fmt.Errorf("파일 다운로드 실패: %v", err)
		}
		
		util.Log(util.ColorGreen, "파일 다운로드 완료!\n")
		
		// Git commit (옵션에 따라 생략 가능)
		if opts == nil || !opts.SkipCommit {
			util.Log(util.ColorCyan, "Git commit을 시작합니다...\n")
			commitChan := h.gitCommitAsync(MSG_DOWNLOAD_HOST_SYNC)
			
			// commit 완료 대기
			result := <-commitChan
			if result.Error != nil {
				util.Log(util.ColorYellow, "Git commit 실패 (파일은 정상 다운로드됨): %v\n", result.Error)
			} else {
				util.Log(util.ColorGreen, "Git commit 완료: %s (%.2fs, %d개 파일)\n", 
					result.Message, result.Duration.Seconds(), result.FileCount)
			}
		} else {
			util.Log(util.ColorCyan, "옵션에 따라 Git commit을 생략합니다.\n")
		}
		
		util.Log(util.ColorBrightGreen, "✅ Host 파일 다운로드 완료!\n")
		return nil
	} else if fileType == "DIR" {
		return h.pullHostDirectory(cm, hostPath, localPath, opts)
	}
	
	return fmt.Errorf("알 수 없는 파일 타입입니다")
}

// pullHostDirectory는 호스트의 디렉토리를 다운로드합니다
func (h *GitHandler) pullHostDirectory(cm *ConnectionManager, hostPath, localPath string, opts *PullOptions) error {
	// apps 경로 특수 처리 (배치 파일과 동일)
	if strings.Contains(hostPath, "apps") {
		util.Log(util.ColorYellow, "'apps' 경로이므로 전체를 pull로 복사합니다.\n")
		
		// 로컬 디렉토리 생성
		if err := os.MkdirAll(localPath, 0755); err != nil {
			return fmt.Errorf("로컬 디렉토리 생성 실패: %v", err)
		}
		
		if err := PullFileWithProgress(cm, hostPath, localPath); err != nil {
			return fmt.Errorf("앱 디렉토리 다운로드 실패: %v", err)
		}
		
		// Git commit (옵션에 따라 생략 가능)
		if opts == nil || !opts.SkipCommit {
			util.Log(util.ColorCyan, "Git commit을 시작합니다...\n")
			commitChan := h.gitCommitAsync(MSG_DOWNLOAD_HOST_SYNC)
			
			// commit 완료 대기
			result := <-commitChan
			if result.Error != nil {
				util.Log(util.ColorYellow, "Git commit 실패: %v\n", result.Error)
			} else {
				util.Log(util.ColorGreen, "Git commit 완료: %s (%.2fs, %d개 파일)\n", 
					result.Message, result.Duration.Seconds(), result.FileCount)
			}
		} else {
			util.Log(util.ColorCyan, "옵션에 따라 Git commit을 생략합니다.\n")
		}
		
		util.Log(util.ColorBrightGreen, "✅ Apps 디렉토리 다운로드 완료!\n")
		return nil
	}
	
	// 연결 타입에 따른 처리 방식 분기
	switch cm.currentConnection.(type) {
	case *SSHConnection:
		// SSH 연결: 디렉토리 전체를 한 번에 다운로드 (tar 압축)
		util.Log(util.ColorCyan, "SSH: 디렉토리를 압축하여 다운로드합니다: %s\n", hostPath)
		
		// 로컬 경로 설정 (사용자 지정 경로 사용)
		localDir := filepath.Dir(localPath)
		
		// 로컬 디렉토리 생성
		if err := os.MkdirAll(localDir, 0755); err != nil {
			return fmt.Errorf("로컬 디렉토리 생성 실패: %v", err)
		}
		
		// 전체 디렉토리를 한 번에 다운로드
		if err := PullFileWithProgress(cm, hostPath, localPath); err != nil {
			util.Log(util.ColorRed, "디렉토리 다운로드 실패: %s, %v\n", hostPath, err)
			util.Log(util.ColorCyan, "다운로드 완료: 0개 성공, 0개 건너뜀\n")
		} else {
			util.Log(util.ColorGreen, "다운로드 완료: 1개 성공, 0개 건너뜀\n")
		}
		
	case *ADBConnection:
		// ADB 연결: 기존 방식 유지 (find 명령으로 개별 파일 처리)
		util.Log(util.ColorCyan, "ADB: 디렉토리 내 파일 목록을 수집합니다...\n")
		findCmd := fmt.Sprintf("find -L '%s'", hostPath)
		output, err := ExcuteOnShell(cm, findCmd)
		if err != nil {
			return fmt.Errorf("파일 목록 수집 실패: %v", err)
		}
		
		files := strings.Split(strings.TrimSpace(output), "\n")
		if len(files) == 1 && files[0] == "" {
			util.Log(util.ColorYellow, "디렉토리에 파일이 없습니다.\n")
			return nil
		}
		
		util.Log(util.ColorCyan, "총 %d개 파일을 검사합니다...\n", len(files))
		downloadedCount := 0
		skippedCount := 0
		
		for i, file := range files {
			file = strings.TrimSpace(file)
			if file == "" {
				continue
			}
			
			util.Log(util.ColorCyan, "[%d/%d] 처리 중: %s\n", i+1, len(files), file)
			
			// 배치 파일의 필터링 로직 적용
			if h.shouldSkipFile(cm, file) {
				skippedCount++
				continue
			}
			
			// 개별 파일 다운로드 (사용자 지정 경로에 상대 경로 적용)
			// 호스트 경로에서 상대 경로 계산
			relPath, err := filepath.Rel(hostPath, file)
			if err != nil {
				util.Log(util.ColorRed, "상대 경로 계산 실패: %s, %v\n", file, err)
				continue
			}
			
			// 사용자 지정 로컬 경로에 상대 경로 적용
			fileLocalPath := filepath.Join(localPath, relPath)
			
			if err := h.pullSingleFile(cm, file, fileLocalPath); err != nil {
				util.Log(util.ColorRed, "파일 다운로드 실패: %s, %v\n", file, err)
			} else {
				downloadedCount++
			}
		}
		
		util.Log(util.ColorGreen, "다운로드 완료: %d개 성공, %d개 건너뜀\n", downloadedCount, skippedCount)
		
	default:
		return fmt.Errorf("지원되지 않는 연결 타입입니다")
	}
	
	// Git commit (옵션에 따라 생략 가능)
	if opts == nil || !opts.SkipCommit {
		util.Log(util.ColorCyan, "Git commit을 시작합니다...\n")
		commitChan := h.gitCommitAsync(MSG_DOWNLOAD_HOST_SYNC)
		
		// commit 완료 대기
		result := <-commitChan
		if result.Error != nil {
			util.Log(util.ColorYellow, "Git commit 실패: %v\n", result.Error)
		} else {
			util.Log(util.ColorGreen, "Git commit 완료: %s (%.2fs, %d개 파일)\n", 
				result.Message, result.Duration.Seconds(), result.FileCount)
		}
	} else {
		util.Log(util.ColorCyan, "옵션에 따라 Git commit을 생략합니다.\n")
	}
	
	util.Log(util.ColorBrightGreen, "✅ Host 디렉토리 다운로드 완료!\n")
	return nil
}// pushHomeyFile은 Homey 파일을 업로드합니다 (private 함수)
func (h *GitHandler) pushHomeyFile(cm *ConnectionManager, option, filePath string) error {
	// Docker data root 경로 동적 조회
	dockerDataRoot, err := h.getDockerDataRoot(cm)
	if err != nil {
		util.Log(util.ColorYellow, "Docker data root 조회 실패, 기본 경로 사용: %v\n", err)
		dockerDataRoot = "/lg_rw/var/lib/docker" // fallback
	}
	
	pathMappings := map[string]struct {
		hostPath    string
		localPrefix string
	}{
		"pro":    {dockerDataRoot + "/volumes/homey-app/_data", DIR_HOMEY_PRO + "/_data"},
		"core":   {dockerDataRoot + "/volumes/homey-node/_data/@athombv/homey-core/dist", DIR_HOMEY_CORE + "/dist"},
		"sdk":    {dockerDataRoot + "/volumes/homey-node/_data/@athombv/homey-apps-sdk-v3", DIR_HOMEY_SDK + "/" + DIR_HOMEY_SDK},
		"bridge": {dockerDataRoot + "/volumes/homey-node/_data/@athombv/homey-bridge", DIR_HOMEY_BRIDGE + "/" + DIR_HOMEY_BRIDGE},
	}
	
	mapping, ok := pathMappings[option]
	if !ok {
		return fmt.Errorf("지원하지 않는 옵션: %s", option)
	}
	
	// 경로에서 ./ 접두사 제거하여 일관성 있게 처리
	cleanFilePath := strings.TrimPrefix(filePath, "./")
	
	// 경로 변환 (배치 파일 로직)
	modifiedPath := strings.Replace(cleanFilePath, mapping.localPrefix, "", 1)
	destPath := mapping.hostPath + modifiedPath
	
	util.Log(util.ColorCyan, "Homey %s 파일 업로드: %s -> %s\n", option, filePath, destPath)
	
	// 파일 업로드
	if err := PushFile(cm, filePath, destPath); err != nil {
		return fmt.Errorf("파일 업로드 실패: %v", err)
	}
	
	util.Log(util.ColorBrightGreen, "✅ 파일 업로드 완료!\n")
	return nil
}

// pushHostFile은 Host 파일을 업로드합니다 (private 함수)
func (h *GitHandler) pushHostFile(cm *ConnectionManager, path string, opts *PushOptions) error {
	// 호스트 경로 결정: opts.HostPath가 있으면 사용, 없으면 기본 변환
	var hostPath string
	if opts != nil && opts.HostPath != "" {
		hostPath = opts.HostPath
	} else {
		hostPath = h.convertHostSyncToHostPath(path)
	}
	
	// 호스트에 상위 디렉토리 생성
	parentDir := filepath.Dir(hostPath)
	// Windows에서 filepath.Dir는 백슬래시를 사용하므로 Linux용으로 변환
	parentDir = strings.ReplaceAll(parentDir, "\\", "/")
	util.Log(util.ColorCyan, "호스트에 상위 디렉토리 생성 시도: %s\n", parentDir)
	if parentDir != "/" && parentDir != "." {
		cmd := fmt.Sprintf("mkdir -p '%s'", parentDir)
		if _, err := ExcuteOnShell(cm, cmd); err != nil {
			util.Log(util.ColorYellow, "상위 디렉토리 생성 실패 (계속 진행): %v\n", err)
		}
	}
	
	// 파일 업로드
	if err := PushFile(cm, path, hostPath); err != nil {
		return fmt.Errorf("파일 업로드 실패: %v", err)
	}
	
	util.Log(util.ColorBrightGreen, "✅ Host 파일 업로드 완료!\n")
	return nil
}

// executeGitCommitInTerminal은 git commit -m을 새로운 터미널 창에서 실행하고 완료를 기다립니다
func (h *GitHandler) executeGitCommitInTerminal(args string) error {
	// git 상태 확인 (staging된 파일 있는지)
	if err := h.checkGitStatusForCommit(); err != nil {
		return fmt.Errorf("git commit 준비 상태 확인 실패: %v", err)
	}

	// git 명령어 구성
	gitCmd := "git " + args

	// 공통 함수로 터미널 실행
	return h.executeCommandInTerminal(gitCmd, "git commit -m")
}

// gitCommitAsync는 git commit을 비동기로 수행하고 결과를 채널로 반환합니다
func (h *GitHandler) gitCommitAsync(message string) <-chan CommitResult {
	resultChan := make(chan CommitResult, 1)

	// 진행 표시와 함께 비동기로 git commit 수행
	asyncResultChan := RunAsyncWithProgress(
		func() (interface{}, error) {
			err := h.gitCommitSync(message)
			fileCount := h.getStagedFileCount()
			return fileCount, err
		},
		"Git commit",
	)

	// 결과를 CommitResult 형식으로 변환
	go func() {
		asyncResult := <-asyncResultChan

		var fileCount int
		if asyncResult.Data != nil {
			fileCount = asyncResult.Data.(int)
		}

		resultChan <- CommitResult{
			Error:     asyncResult.Error,
			Duration:  asyncResult.Duration,
			FileCount: fileCount,
			Message:   message,
		}
	}()

	return resultChan
}

// gitCommitSync은 git add 및 commit을 동기식으로 수행합니다
func (h *GitHandler) gitCommitSync(message string) error {
	// git add .
	if err := exec.Command("git", "add", ".").Run(); err != nil {
		return fmt.Errorf("git add 실패: %v", err)
	}
	
	// staging된 파일이 있는지 확인 (간단한 방식)
	cmd := exec.Command("git", "diff", "--cached", "--name-only")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("staging 파일 확인 실패: %v", err)
	}
	
	stagedFiles := strings.TrimSpace(string(output))
	if stagedFiles == "" {
		util.Log(util.ColorCyan, "변경된 파일이 없어 git commit을 건너뜁니다.\n")
		return nil
	}
	
	// git commit
	if err := exec.Command("git", "commit", "-m", message).Run(); err != nil {
		return fmt.Errorf("git commit 실패: %v", err)
	}
	
	return nil
}

// getStagedFileCount는 현재 staging된 파일 개수를 반환합니다
func (h *GitHandler) getStagedFileCount() int {
	cmd := exec.Command("git", "diff", "--cached", "--name-only")
	output, err := cmd.Output()
	if err != nil {
		return 0
	}
	
	stagedFiles := strings.TrimSpace(string(output))
	if stagedFiles == "" {
		return 0
	}
	
	return len(strings.Split(stagedFiles, "\n"))
}

// checkHostPathExists는 호스트 경로가 존재하는지 확인합니다
func (h *GitHandler) checkHostPathExists(cm *ConnectionManager, hostPath string) (bool, error) {
	cmd := fmt.Sprintf("if [ ! -e '%s' ]; then echo 'NOT_EXISTS'; fi", hostPath)
	output, err := ExcuteOnShell(cm, cmd)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(output) != "NOT_EXISTS", nil
}

// getHostFileType은 호스트 파일의 타입을 확인합니다
func (h *GitHandler) getHostFileType(cm *ConnectionManager, hostPath string) (string, error) {
	cmd := fmt.Sprintf("if [ -f '%s' ]; then echo 'FILE'; elif [ -d '%s' ]; then echo 'DIR'; fi", hostPath, hostPath)
	output, err := ExcuteOnShell(cm, cmd)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
}

// shouldSkipFile은 파일을 건너뛸지 결정합니다 (배치 파일 로직 완전 이식)
func (h *GitHandler) shouldSkipFile(cm *ConnectionManager, filePath string) bool {
	// 1. 특수문자 검사
	invalidChars := []string{":", "<", ">", "|"}
	for _, char := range invalidChars {
		if strings.Contains(filePath, char) {
			util.Log(util.ColorYellow, "[경고] SKIP: 파일명에 사용 불가 문자(%s) 포함 - %s\n", char, filePath)
			return true
		}
	}
	
	// 2. 파일 크기 검사 (50MB 제한)
	sizeCmd := fmt.Sprintf(`stat -c %%s %s`, filePath)
	output, err := ExcuteOnShell(cm, sizeCmd)
	if err != nil {
		util.Log(util.ColorYellow, "[경고] SKIP: 파일 크기 확인 실패 - %s\n", filePath)
		return true
	}
	
	fileSize := strings.TrimSpace(output)
	if size, err := strconv.ParseInt(fileSize, 10, 64); err == nil {
		if size > 50*1024*1024 { // 50MB
			util.Log(util.ColorYellow, "[경고] SKIP: 50MB 초과 파일 - %s\n", filePath)
			util.Log(util.ColorCyan, "[정보] Size: %d bytes (%.2f MB)\n", size, float64(size)/(1024*1024))
			return true
		}
	} else {
		util.Log(util.ColorYellow, "[경고] SKIP: 파일 크기 파싱 실패 - %s\n", filePath)
		return true
	}
	
	return false
}

// pullSingleFile은 개별 파일을 다운로드합니다
func (h *GitHandler) pullSingleFile(cm *ConnectionManager, remotePath, localPath string) error {
	// 로컬 디렉토리 생성
	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return fmt.Errorf("로컬 디렉토리 생성 실패: %v", err)
	}
	
	// 파일 다운로드 (진행 시간 표시)
	return PullFileWithProgress(cm, remotePath, localPath)
}

// convertToLocalPath는 호스트 경로를 로컬 경로로 변환합니다
func (h *GitHandler) convertToLocalPath(hostPath string) string {
	// /lg_rw/var/lib/... -> ./host_sync/lg_rw/var/lib/...
	return filepath.Join("./host_sync", strings.TrimPrefix(hostPath, "/"))
}

// convertHostSyncToHostPath는 로컬 host_sync 경로를 호스트 경로로 변환합니다
func (h *GitHandler) convertHostSyncToHostPath(localPath string) string {
	// 경로를 정규화 (백슬래시를 슬래시로 통일)
	normalizedPath := strings.ReplaceAll(localPath, "\\", "/")
	
	// host_sync 패턴 찾기 (경로 어디에든 있을 수 있음)
	hostSyncIndex := strings.Index(normalizedPath, "host_sync/")
	if hostSyncIndex == -1 {
		// host_sync 패턴이 없으면 원본 그대로 반환
		return localPath
	}
	
	// host_sync/ 이후의 경로 추출
	afterHostSync := normalizedPath[hostSyncIndex+len("host_sync/"):]
	
	// 호스트 절대경로로 변환
	if afterHostSync == "" {
		return "/"
	}
	
	return "/" + afterHostSync
}

// getDockerDataRoot는 호스트에서 Docker data root 경로를 조회합니다
func (h *GitHandler) getDockerDataRoot(cm *ConnectionManager) (string, error) {
	// docker info --format '{{.DockerRootDir}}' 명령어 실행
	cmd := "docker info --format '{{.DockerRootDir}}'"
	output, err := ExcuteOnShell(cm, cmd)
	if err != nil {
		return "", fmt.Errorf("docker info 명령어 실행 실패: %v", err)
	}
	
	dockerRoot := strings.TrimSpace(output)
	if dockerRoot == "" {
		return "", fmt.Errorf("docker data root 경로를 가져올 수 없습니다")
	}
	
	return dockerRoot, nil
}

// executeCommandInTerminal은 명령어를 새로운 터미널 창에서 실행하고 완료까지 기다립니다
func (h *GitHandler) executeCommandInTerminal(command string, description string) error {
	// PowerShell로 cmd 프로세스 시작하고 완료까지 대기
	psCommand := fmt.Sprintf(`
		try {
			$process = Start-Process -FilePath 'cmd' -ArgumentList '/c', '%s && echo 작업 완료' -PassThru -Wait
			Write-Host "COMPLETED:$($process.ExitCode)"
		} catch {
			Write-Host "ERROR:$($_.Exception.Message)"
		}
	`, command)

	// ProgressTracker로 진행 상황 표시
	progress := NewProgressTracker(fmt.Sprintf("%s 터미널 작업", description))
	progress.Start()
	defer progress.Finish()

	// PowerShell 실행 및 결과 대기
	cmd := exec.Command("powershell", "-Command", psCommand)
	output, err := cmd.Output()
	if err != nil {
		util.Log(util.ColorRed, "터미널 작업 실행 실패: %v\n", err)
		return fmt.Errorf("터미널 작업 실패: %v", err)
	}

	// 결과 분석
	outputStr := string(output)
	util.Log(util.ColorCyan, "터미널 작업 결과: %s\n", strings.TrimSpace(outputStr))

	if strings.Contains(outputStr, "ERROR:") {
		util.Log(util.ColorRed, "%s 작업 중 에러 발생\n", description)
		return fmt.Errorf("%s 작업 에러", description)
	}

	if strings.Contains(outputStr, "COMPLETED:") {
		util.Log(util.ColorGreen, "✅ %s 작업이 완료되었습니다!\n", description)
		return nil
	}

	util.Log(util.ColorYellow, "터미널 작업 결과를 확인할 수 없습니다.\n")
	return nil
}

// checkGitStatusForAmend은 git commit --amend를 위한 상태를 확인합니다
func (h *GitHandler) checkGitStatusForAmend() error {
	// git log로 커밋 히스토리가 있는지 확인
	cmd := exec.Command("git", "log", "--oneline", "-1")
	err := cmd.Run()
	if err != nil {
		return fmt.Errorf("커밋 히스토리가 없습니다. git commit --amend를 사용할 수 없습니다")
	}

	return nil
}

// checkGitStatusForCommit은 git commit을 위한 상태를 확인합니다
func (h *GitHandler) checkGitStatusForCommit() error {
	// git status 확인
	cmd := exec.Command("git", "status", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("git status 확인 실패: %v", err)
	}

	// 변경사항이 있는지 확인
	if len(strings.TrimSpace(string(output))) == 0 {
		return fmt.Errorf("커밋할 변경사항이 없습니다")
	}

	return nil
}

// displayGitStatusWithColors는 git status를 색상으로 구분해서 표시합니다
func (h *GitHandler) displayGitStatusWithColors() error {
	// git status --porcelain로 기계가 읽을 수 있는 형식으로 출력 얻기
	cmd := exec.Command("git", "status", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("git status 확인 실패: %v", err)
	}

	// 브랜치 정보도 함께 표시
	branchCmd := exec.Command("git", "branch", "--show-current")
	branchOutput, branchErr := branchCmd.Output()
	
	if branchErr == nil {
		branch := strings.TrimSpace(string(branchOutput))
		util.Log(util.ColorWhite, "On branch %s\n", branch)
	}
	
	// porcelain 출력 파싱 및 색상 적용
	porcelainOutput := strings.TrimSpace(string(output))
	if porcelainOutput == "" {
		util.Log(util.ColorGreen, "✅ Nothing to commit, working tree clean\n")
		return nil
	}
	
	stagedFiles := make(map[string]string) // filename -> status description
	unstagedFiles := make(map[string]string) // filename -> status description
	untrackedFiles := []string{}
	
	lines := strings.Split(porcelainOutput, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if len(line) < 3 {
			continue
		}
		
		status := line[:2]  // XY 형식의 상태 코드
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		filename := fields[1] // filename은 두 번째 필드
		
		// X: index 상태, Y: working tree 상태
		indexStatus := status[0]
		workingStatus := status[1]
		
		// Index에 staged된 파일들 처리
		if indexStatus != ' ' && indexStatus != '?' {
			var statusDesc string
			switch indexStatus {
			case 'A':
				statusDesc = "new file"
			case 'M':
				statusDesc = "modified"
			case 'D':
				statusDesc = "deleted"
			case 'R':
				statusDesc = "renamed"
			case 'C':
				statusDesc = "copied"
			default:
				statusDesc = "modified"
			}
			stagedFiles[filename] = statusDesc
		}
		
		// Working tree에 변경사항이 있는 파일들 (unstaged)
		if workingStatus != ' ' && workingStatus != '?' {
			var statusDesc string
			switch workingStatus {
			case 'M':
				statusDesc = "modified"
			case 'D':
				statusDesc = "deleted"
			default:
				statusDesc = "modified"
			}
			unstagedFiles[filename] = statusDesc
		}
		
		// Untracked files
		if status == "??" {
			untrackedFiles = append(untrackedFiles, filename)
		}
	}
	
	// Staged files 표시 (초록색)
	if len(stagedFiles) > 0 {
		util.Log(util.ColorWhite, "\nChanges to be committed:\n")
		util.Log(util.ColorWhite, "  (use \"git restore --staged <file>...\" to unstage)\n")
		util.Log(util.ColorWhite, "\n")
		for filename, statusDesc := range stagedFiles {
			util.Log(util.ColorGreen, "\t%s:   %s\n", statusDesc, filename)
		}
	}
	
	// Unstaged files 표시 (빨간색)
	if len(unstagedFiles) > 0 {
		util.Log(util.ColorWhite, "\nChanges not staged for commit:\n")
		util.Log(util.ColorWhite, "  (use \"git add <file>...\" to update what will be committed)\n")
		util.Log(util.ColorWhite, "  (use \"git restore <file>...\" to discard changes in working directory)\n")
		util.Log(util.ColorWhite, "\n")
		for filename, statusDesc := range unstagedFiles {
			util.Log(util.ColorRed, "\t%s:   %s\n", statusDesc, filename)
		}
	}
	
	// Untracked files 표시 (빨간색)
	if len(untrackedFiles) > 0 {
		util.Log(util.ColorWhite, "\nUntracked files:\n")
		util.Log(util.ColorWhite, "  (use \"git add <file>...\" to include in what will be committed)\n")
		util.Log(util.ColorWhite, "\n")
		for _, file := range untrackedFiles {
			util.Log(util.ColorRed, "\t%s\n", file)
		}
	}
	
	return nil
}
