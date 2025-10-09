package lib

// 기본 폴더 이름 상수들
const (
	DIR_HOMEY_PRO    = "homey_pro"
	DIR_HOMEY_CORE   = "homey_core"
	DIR_HOMEY_SDK    = "homey-apps-sdk-v3"
	DIR_HOMEY_BRIDGE = "homey-bridge"
	DIR_HOST_SYNC    = "host_sync"
)

// 기본 폴더 경로 상수들 (초기화 시 사용)
const (
	DEFAULT_PRO_DIRECTORY       = "./" + DIR_HOMEY_PRO + "/" + "_data"
	DEFAULT_CORE_DIRECTORY      = "./" + DIR_HOMEY_CORE + "/" + "dist"
	DEFAULT_SDK_DIRECTORY       = "./" + DIR_HOMEY_SDK + "/" + DIR_HOMEY_SDK
	DEFAULT_BRIDGE_DIRECTORY    = "./" + DIR_HOMEY_BRIDGE + "/" + DIR_HOMEY_BRIDGE
	DEFAULT_HOST_SYNC_DIRECTORY = "./" + DIR_HOST_SYNC + "/" + "tmp"
)

// Git 커밋 메시지 상수들
const (
	MSG_DOWNLOAD_HOMEY_PRO    = "[Do not push]download Homey-pro"
	MSG_DOWNLOAD_HOMEY_CORE   = "[Do not push]download Homey-core"
	MSG_DOWNLOAD_HOMEY_SDK    = "[Do not push]download homey-apps-sdk-v3"
	MSG_DOWNLOAD_HOMEY_BRIDGE = "[Do not push]download homey-bridge"
	MSG_DOWNLOAD_HOST_SYNC    = "[Do not push]download host_sync"
)

// LogBuffer 관련 상수들
const (
	LOG_BUFFER_MAX_SIZE = 1000 // 메모리 버퍼 최대 로그 수 (실시간 스트리밍용)
)

// 로그 파일 통합 관련 상수들
const (
	TYPE_LOG_BUFFER_SIZE    = 500 // 타입별 로그 버퍼 크기
	MAIN_BUFFER_SIZE        = 500 // 최종 메인 버퍼 크기
	FILE_CHUNK_SIZE         = 500 // 파일 읽기 청크 크기
	TIMEZONE_JUMP_THRESHOLD = 6   // 타임존 점프 감지 임계값 (시간)
)

// 기본 폴더 경로 목록 (초기화 시 사용)
var DEFAULT_WORKSPACE_DIR_PATHS = []string{
	DEFAULT_PRO_DIRECTORY,
	DEFAULT_CORE_DIRECTORY,
	DEFAULT_SDK_DIRECTORY,
	DEFAULT_BRIDGE_DIRECTORY,
	DEFAULT_HOST_SYNC_DIRECTORY,
}

// Git 커밋 메시지 목록 (건너뛰기 체크용)
var SKIP_COMMIT_MESSAGES = []string{
	MSG_DOWNLOAD_HOMEY_PRO,
	MSG_DOWNLOAD_HOMEY_CORE,
	MSG_DOWNLOAD_HOMEY_SDK,
	MSG_DOWNLOAD_HOMEY_BRIDGE,
	MSG_DOWNLOAD_HOST_SYNC,
}
