package lib

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"edgetool/util"
)

// 디버그 모드 설정
const DEBUG_COMMAND_EXECUTION = false

func ExecuteShellCommand(command string, timeout time.Duration) (string, error) {
	var ctx context.Context
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), timeout)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	defer cancel()

	if DEBUG_COMMAND_EXECUTION {
		util.Log("[%s] Executing command: %s\n", runtime.GOOS, command)
	}
	
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		// Windows에서 모든 명령어를 PowerShell로 처리
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", command)
	}

	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	if err := cmd.Run(); err != nil {
		// If context deadline exceeded, return that error
		if ctx.Err() == context.DeadlineExceeded {
			return outBuf.String() + errBuf.String(), ctx.Err()
		}
		// Return combined output and the error
		return outBuf.String() + errBuf.String(), err
	}

	// Success — return combined output
	return outBuf.String() + errBuf.String(), nil
}

// sshCommandRunner generates and executes SSH or file transfer command.
// type: "ssh" for command execution, "scp" for file transfer
// For "ssh": args = [command]
// For "scp": args = [direction, localPath, remotePath] where direction is "upload" or "download"
// Returns the output for "ssh", or error for both.
func sshCommandRunner(conn *SSHConnection, cmdType string, args ...string) (string, error) {
	if conn.host == "" || conn.user == "" {
		return "", errors.New("SSH host/user not set")
	}
	port := conn.port
	if port == "" {
		port = "22"
	}

	if cmdType == "ssh" {
		if len(args) != 1 {
			return "", errors.New("ssh requires 1 arg: command")
		}
		command := args[0]

		// SSH 명령어 실행 (PowerShell을 통해)
		sshCmd := fmt.Sprintf("ssh -p %s %s@%s \"%s\"", port, conn.user, conn.host, strings.ReplaceAll(command, `"`, `\"`))
		if DEBUG_COMMAND_EXECUTION {
			util.Log("SSH 명령어 실행: %s\n", sshCmd)
		}
		output, err := ExecuteShellCommand(sshCmd, 30*time.Second)
		if err != nil {
			if DEBUG_COMMAND_EXECUTION {
				util.Log("SSH 명령어 실행 실패 - 출력: %s, 에러: %v\n", output, err)
			}
			return output, fmt.Errorf("SSH 명령어 실행 실패: %w", err)
		}
		return output, nil

	} else if cmdType == "scp" {
		if len(args) != 3 {
			return "", errors.New("scp requires 3 args: direction, remotePath, localPath for download OR direction, localPath, remotePath for upload")
		}
		direction := args[0]
		
		var localPath, remotePath string
		if direction == "download" {
			// download: args = [direction, remotePath, localPath]
			remotePath, localPath = args[1], args[2]
		} else if direction == "upload" {
			// upload: args = [direction, localPath, remotePath]
			localPath, remotePath = args[1], args[2]
		} else {
			return "", errors.New("invalid direction: use 'upload' or 'download'")
		}

		// FileResourceManager 생성 (함수 시작 시)
		frm := util.NewLocalFileResourceManager()
		defer frm.Cleanup() // 함수 종료 시 자동 정리

		// SFTP 서버 없이 SSH + tar 사용하여 중간 파일 방식으로 처리
		if direction == "upload" {
			// 업로드: base64 인코딩 방식으로 호환성 문제 해결
			localParent := filepath.Dir(localPath)
			localName := filepath.Base(localPath)
			
			// 원격 디렉토리는 Linux 경로 형식으로 처리
			remoteDir := filepath.ToSlash(filepath.Dir(remotePath))
			
			// FileResourceManager로 임시 파일 생성
			tempFile, err := frm.CreateTempFile("upload", ".tar")
			if err != nil {
				return "", fmt.Errorf("임시 tar 파일 생성 실패: %w", err)
			}
			tempB64File, err := frm.CreateTempFile("upload", ".tar.b64")
			if err != nil {
				return "", fmt.Errorf("임시 base64 파일 생성 실패: %w", err)
			}
			
			// 3단계 처리: 1) 로컬에서 tar 생성, 2) base64 인코딩, 3) 원격으로 전송 후 디코딩 및 압축 해제
			createCmd := fmt.Sprintf("tar -cf \"%s\" -C \"%s\" \"%s\"", 
				tempFile, localParent, localName)
			encodeCmd := fmt.Sprintf("[Convert]::ToBase64String([IO.File]::ReadAllBytes(\"%s\")) | Out-File -Encoding ASCII \"%s\"", tempFile, tempB64File)
			uploadCmd := fmt.Sprintf("type \"%s\" | ssh -p %s %s@%s \"base64 -d | tar -xf - -C %s\"", 
				tempB64File, port, conn.user, conn.host, remoteDir)
			
			// tar 생성 실행
			if DEBUG_COMMAND_EXECUTION {
				util.Log("SSH tar 생성 명령어 실행: %s\n", createCmd)
			}
			output1, err := ExecuteShellCommand(createCmd, 60*time.Second)
			if err != nil {
				if DEBUG_COMMAND_EXECUTION {
					util.Log("SSH tar 생성 실패 - 출력: %s, 에러: %v\n", output1, err)
				}
				return output1, fmt.Errorf("SSH tar 생성 실패: %w", err)
			}
			
			// base64 인코딩 실행
			if DEBUG_COMMAND_EXECUTION {
				util.Log("base64 인코딩 명령어 실행: %s\n", encodeCmd)
			}
			output2, err := ExecuteShellCommand(encodeCmd, 30*time.Second)
			if err != nil {
				if DEBUG_COMMAND_EXECUTION {
					util.Log("base64 인코딩 실패 - 출력: %s, 에러: %v\n", output2, err)
				}
				return output2, fmt.Errorf("base64 인코딩 실패: %w", err)
			}
			
			// 업로드 및 압축 해제 실행
			if DEBUG_COMMAND_EXECUTION {
				util.Log("SSH base64 업로드 명령어 실행: %s\n", uploadCmd)
			}
			output3, err := ExecuteShellCommand(uploadCmd, 60*time.Second)
			if err != nil {
				if DEBUG_COMMAND_EXECUTION {
					util.Log("SSH base64 업로드 실패 - 출력: %s, 에러: %v\n", output3, err)
				}
				return output3, fmt.Errorf("SSH base64 업로드 실패: %w", err)
			}
			
			return "파일 업로드 완료", nil

		} else if direction == "download" {
			// 다운로드: base64 인코딩 방식으로 호환성 문제 해결
			localDir := filepath.Dir(localPath)
			localName := filepath.Base(localPath)
			if localDir != "." {
				// 로컬 디렉토리 생성
				if err := os.MkdirAll(localDir, 0755); err != nil {
					return "", fmt.Errorf("로컬 디렉토리 생성 실패: %w", err)
				}
			}
			
			// FileResourceManager로 임시 파일 생성
			tempFile, err := frm.CreateTempFile("download", ".tar.b64")
			if err != nil {
				return "", fmt.Errorf("임시 base64 파일 생성 실패: %w", err)
			}
			
			// 3단계 처리: 1) 원격에서 tar 생성 후 base64 인코딩, 2) 로컬로 저장, 3) base64 디코딩 후 압축 해제
			// 경로 분리하여 디렉토리 내용만 압축 (경로 중복 방지)
			remoteParent := filepath.ToSlash(filepath.Dir(remotePath))
			remoteName := filepath.Base(remotePath)
			if remoteParent == "/" {
				remoteParent = "/"
			}
			
			downloadCmd := fmt.Sprintf("ssh -p %s %s@%s \"tar -cf - -C %s %s | base64\" > \"%s\"", 
				port, conn.user, conn.host, remoteParent, remoteName, tempFile)
			decodeCmd := fmt.Sprintf("[IO.File]::WriteAllBytes(\"%s.tar\", [Convert]::FromBase64String((Get-Content \"%s\" -Raw)))", tempFile, tempFile)
			
			// 로컬 파일명 지정하여 추출 (상대 경로 지원)
			var extractCmd string
			if localDir == "." {
				// 현재 디렉토리에 임시 디렉토리 생성 후 추출하고 파일명 변경
				tempExtractDir := fmt.Sprintf("temp_extract_%d", time.Now().Unix())
				extractCmd = fmt.Sprintf("if (Test-Path \"%s\") { Remove-Item \"%s\" -Force }; mkdir \"%s\"; tar -xf \"%s.tar\" -C \"%s\"; if (Test-Path \"%s\") { Move-Item \"%s/%s\" \"%s\" -Force }; Remove-Item \"%s\" -Recurse -Force", 
					localName, localName, tempExtractDir, tempFile, tempExtractDir, fmt.Sprintf("%s/%s", tempExtractDir, remoteName), tempExtractDir, remoteName, localName, tempExtractDir)
			} else {
				// 지정된 디렉토리에 임시 디렉토리 생성 후 추출하고 파일명 변경
				tempExtractDir := fmt.Sprintf("%s/temp_extract_%d", localDir, time.Now().Unix())
				extractCmd = fmt.Sprintf("if (!(Test-Path \"%s\")) { New-Item \"%s\" -ItemType Directory -Force }; if (Test-Path \"%s/%s\") { Remove-Item \"%s/%s\" -Force }; mkdir \"%s\"; tar -xf \"%s.tar\" -C \"%s\"; if (Test-Path \"%s/%s\") { Move-Item \"%s/%s\" \"%s/%s\" -Force }; Remove-Item \"%s\" -Recurse -Force", 
					localDir, localDir, localDir, localName, localDir, localName, tempExtractDir, tempFile, tempExtractDir, tempExtractDir, remoteName, tempExtractDir, remoteName, localDir, localName, tempExtractDir)
			}
			
			// 다운로드 실행
			if DEBUG_COMMAND_EXECUTION {
				util.Log("SSH base64 다운로드 명령어 실행: %s\n", downloadCmd)
			}
			output1, err := ExecuteShellCommand(downloadCmd, 60*time.Second)
			if err != nil {
				if DEBUG_COMMAND_EXECUTION {
					util.Log("SSH base64 다운로드 실패 - 출력: %s, 에러: %v\n", output1, err)
				}
				return output1, fmt.Errorf("SSH base64 다운로드 실패: %w", err)
			}
			
			// base64 디코딩 실행
			if DEBUG_COMMAND_EXECUTION {
				util.Log("base64 디코딩 명령어 실행: %s\n", decodeCmd)
			}
			output2, err := ExecuteShellCommand(decodeCmd, 30*time.Second)
			if err != nil {
				if DEBUG_COMMAND_EXECUTION {
					util.Log("base64 디코딩 실패 - 출력: %s, 에러: %v\n", output2, err)
				}
				return output2, fmt.Errorf("base64 디코딩 실패: %w", err)
			}
			
			// 압축 해제 실행
			if DEBUG_COMMAND_EXECUTION {
				util.Log("tar 압축해제 명령어 실행: %s\n", extractCmd)
			}
			output3, err := ExecuteShellCommand(extractCmd, 30*time.Second)
			if err != nil {
				if DEBUG_COMMAND_EXECUTION {
					util.Log("tar 압축해제 실패 - 출력: %s, 에러: %v\n", output3, err)
				}
				return output3, fmt.Errorf("tar 압축해제 실패: %w", err)
			}
			
			return "파일 다운로드 완료", nil

		} else {
			return "", errors.New("invalid direction: use 'upload' or 'download'")
		}
	} else {
		return "", errors.New("invalid cmdType: use 'ssh' or 'scp'")
	}
}

// ShellRunner is a replaceable function used to run shell commands. Tests may replace this.
var ShellRunner = ExecuteShellCommand

func ExcuteOnShell(cm *ConnectionManager, command string) (string, error) {
	return excuteOnShellInternal(cm, command, false)
}

// ExcuteOnShellQuiet: 조용한 모드로 명령어 실행 (로그 출력 없음)
func ExcuteOnShellQuiet(cm *ConnectionManager, command string) (string, error) {
	return excuteOnShellInternal(cm, command, true)
}

// excuteOnShellInternal: 내부 구현 함수
func excuteOnShellInternal(cm *ConnectionManager, command string, quiet bool) (string, error) {
	if cm == nil || cm.currentConnection == nil {
		return "", errors.New("no active connection")
	}
	if !cm.currentConnection.IsConnected() {
		return "", errors.New("connection is not established")
	}

	switch conn := cm.currentConnection.(type) {
	case *ADBConnection:
		if conn.deviceID == "" {
			return "", errors.New("ADB device ID is not set")
		}
		// ADB 명령어를 PowerShell을 통해 실행 (통합 처리)
		escaped := strings.ReplaceAll(command, `"`, `\"`)
		adbCmd := fmt.Sprintf(`adb -s %s shell "%s"`, conn.deviceID, escaped)
		if !quiet {
			util.Log("ADB 명령어 실행: %s\n", adbCmd)
		}
		output, err := ShellRunner(adbCmd, 30*time.Second)
		if err != nil {
			if output != "" {
				return output, fmt.Errorf("ADB shell error: %s", output)
			}
			return output, err
		}
		return output, nil
	case *SSHConnection:
		return sshCommandRunner(conn, "ssh", command)
	default:
		return "", errors.New("unsupported connection type")
	}
}

// PushFile pushes a file from local to remote host.
// For ADB: uses adb push
// For SSH: uses scp upload
func PushFile(cm *ConnectionManager, localPath, remotePath string) error {
	if cm == nil || cm.currentConnection == nil {
		return errors.New("no active connection")
	}
	if !cm.currentConnection.IsConnected() {
		return errors.New("connection is not established")
	}

	switch conn := cm.currentConnection.(type) {
	case *ADBConnection:
		if conn.deviceID == "" {
			return errors.New("ADB device ID is not set")
		}
		adbCmd := fmt.Sprintf("adb -s %s push %s %s", conn.deviceID, localPath, remotePath)
		output, err := ShellRunner(adbCmd, 60*time.Second)
		if err != nil {
			if output != "" {
				return fmt.Errorf("ADB push error: %s", output)
			}
			return fmt.Errorf("ADB push failed: %w", err)
		}
		return nil
	case *SSHConnection:
		_, err := sshCommandRunner(conn, "scp", "upload", localPath, remotePath)
		if err != nil {
			return fmt.Errorf("SSH push failed: %w", err)
		}
		return nil
	default:
		return errors.New("unsupported connection type for push")
	}
}

// PullFileWithProgress pulls a file from remote host to local with real-time progress display.
// For ADB: uses adb pull
// For SSH: uses scp download
func PullFileWithProgress(cm *ConnectionManager, remotePath, localPath string) error {
	return RunWithProgress(
		func() error {
			return PullFile(cm, remotePath, localPath)
		},
		"파일 다운로드",
	)
}

// PullFile pulls a file from remote host to local.
// For ADB: uses adb pull
// For SSH: uses scp download
func PullFile(cm *ConnectionManager, remotePath, localPath string) error {
	if cm == nil || cm.currentConnection == nil {
		return errors.New("no active connection")
	}
	if !cm.currentConnection.IsConnected() {
		return errors.New("connection is not established")
	}

	switch conn := cm.currentConnection.(type) {
	case *ADBConnection:
		if conn.deviceID == "" {
			return errors.New("ADB device ID is not set")
		}
		adbCmd := fmt.Sprintf("adb -s %s pull %s %s", conn.deviceID, remotePath, localPath)
		output, err := ShellRunner(adbCmd, 60*time.Second)
		if err != nil {
			if output != "" {
				return fmt.Errorf("ADB pull error: %s", output)
			}
			return fmt.Errorf("ADB pull failed: %w", err)
		}
		return nil
	case *SSHConnection:
		_, err := sshCommandRunner(conn, "scp", "download", remotePath, localPath)
		if err != nil {
			return fmt.Errorf("SSH pull failed: %w", err)
		}
		return nil
	default:
		return errors.New("unsupported connection type for pull")
	}
}

// CreateAndExecuteScript creates a script, pushes it to remote, executes it, and cleans up
// scriptType: "sed", "bash", "sh" etc.
// scriptName: unique name for the script
// scriptContent: the actual script content
// targetFile: target file to operate on (for sed scripts)
func CreateAndExecuteScript(cm *ConnectionManager, scriptType, scriptName, scriptContent, targetFile string) error {
	// FileResourceManager 생성
	frm := util.NewLocalFileResourceManager()
	defer frm.Cleanup()
	
	// FileResourceManager로 로컬 temp 스크립트 파일 생성
	localScriptPath, err := frm.CreateTempFile(scriptName, "."+scriptType)
	if err != nil {
		return fmt.Errorf("스크립트 파일 생성 실패: %v", err)
	}
	
	// Create script content with proper formatting
	if err := createLocalScript(localScriptPath, scriptContent); err != nil {
		return fmt.Errorf("스크립트 파일 생성 실패: %v", err)
	}
	
	// 2. Push script to remote
	remoteScriptPath := fmt.Sprintf("/tmp/%s.%s", scriptName, scriptType)
	if err := PushFile(cm, localScriptPath, remoteScriptPath); err != nil {
		return fmt.Errorf("스크립트 파일 전송 실패: %v", err)
	}
	util.Log(util.ColorGreen, "스크립트 파일 전송 완료: %s\n", remoteScriptPath)
	
	// 3. Execute script based on type
	var executeCmd string
	switch scriptType {
	case "sed":
		if targetFile == "" {
			cleanupRemoteScript(cm, remoteScriptPath)
			return fmt.Errorf("sed 스크립트는 타겟 파일이 필요합니다")
		}
		executeCmd = fmt.Sprintf("sed -f %s %s > %s.new && mv %s.new %s", 
			remoteScriptPath, targetFile, targetFile, targetFile, targetFile)
	case "bash", "sh":
		chmodCmd := fmt.Sprintf("chmod +x %s", remoteScriptPath)
		if _, err := ExcuteOnShell(cm, chmodCmd); err != nil {
			cleanupRemoteScript(cm, remoteScriptPath)
			return fmt.Errorf("스크립트 실행 권한 설정 실패: %v", err)
		}
		executeCmd = fmt.Sprintf("%s %s", scriptType, remoteScriptPath)
	default:
		cleanupRemoteScript(cm, remoteScriptPath)
		return fmt.Errorf("지원되지 않는 스크립트 타입: %s", scriptType)
	}
	
	if _, err := ExcuteOnShell(cm, executeCmd); err != nil {
		// Cleanup remote script on error
		cleanupRemoteScript(cm, remoteScriptPath)
		return fmt.Errorf("스크립트 실행 실패: %v", err)
	}
	util.Log(util.ColorGreen, "%s 스크립트 실행 완료\n", scriptType)
	
	// 4. Cleanup remote script
	if err := cleanupRemoteScript(cm, remoteScriptPath); err != nil {
		util.Log(util.ColorYellow, "원격 스크립트 파일 삭제 실패: %v\n", err)
	} else {
		util.Log(util.ColorGreen, "원격 스크립트 파일 삭제 완료\n")
	}
	
	return nil
}

// createLocalScript creates a local script file
func createLocalScript(filePath, content string) error {
	file, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	_, err = file.WriteString(content)
	return err
}

// cleanupRemoteScript removes the remote script file
func cleanupRemoteScript(cm *ConnectionManager, remoteScriptPath string) error {
	rmCmd := fmt.Sprintf("rm -f %s", remoteScriptPath)
	_, err := ExcuteOnShell(cm, rmCmd)
	return err
}
