package logviewer

// LogBufferInterface는 모든 LogBuffer 구현체가 따라야 하는 인터페이스입니다
type LogBufferInterface interface {
	// 로그 추가 및 관리
	AddLog(entry LogEntry)
	
	// 클라이언트 구독 관리  
	Subscribe(clientID string) chan LogEntry
	Unsubscribe(clientID string, ch chan LogEntry)
	
	// 클라이언트별 로그 조회
	GetNewLogs(clientID string) []LogEntry
	MarkConsumed(clientID string, logID int64)
	
	// 범위 기반 로그 조회 (하이브리드 기능)
	GetLogsInRange(startID, endID int64) []LogEntry
	GetLogsByScrollPosition(scrollTop float64, viewportHeight float64, totalHeight float64) []LogEntry
	
	// 검색 기능
	Search(keyword string) []LogEntry
	ExitSearchMode()
	IsSearchMode() bool
	GetSearchResults() []LogEntry
	
	// 상태 및 관리
	GetStats() map[string]interface{}
	Cleanup()
	Close()
}

// LogBufferType은 LogBuffer의 종류를 나타냅니다
type LogBufferType string

const (
	BufferTypeMemoryOnly LogBufferType = "memory_only" // 메모리 전용 (기존 방식)
	BufferTypeHybrid     LogBufferType = "hybrid"      // 메모리 + 파일 하이브리드
	BufferTypeFileOnly   LogBufferType = "file_only"   // 파일 중심 (초대용량)
)

// LogBufferConfig는 LogBuffer 생성 시 설정 구조체입니다
type LogBufferConfig struct {
	Type            LogBufferType `json:"type"`             // 버퍼 타입
	MaxMemorySize   int           `json:"max_memory_size"`  // 메모리 최대 로그 수 (실시간 버퍼)
	LogsDirectory   string        `json:"logs_directory"`   // 로그 파일 저장 디렉토리
	FileMaxSize     int64         `json:"file_max_size"`    // 파일 최대 크기 (바이트)
	EnableIndexing  bool          `json:"enable_indexing"`  // 검색 인덱스 사용 여부
	ViewportSize    int           `json:"viewport_size"`    // 뷰포트 버퍼 크기 (각각)
}

// DefaultConfigs는 각 타입별 기본 설정을 제공합니다
var DefaultConfigs = map[LogBufferType]LogBufferConfig{
	BufferTypeMemoryOnly: {
		Type:          BufferTypeMemoryOnly,
		MaxMemorySize: DefaultMaxSize,
	},
	BufferTypeHybrid: {
		Type:            BufferTypeHybrid,
		MaxMemorySize:   RealtimeBufferSize, // 실시간 로그 버퍼
		LogsDirectory:   "./logs/raw",       // 파일 저장 위치
		FileMaxSize:     50 * 1024 * 1024,   // 50MB per file
		EnableIndexing:  true,               // 검색 인덱스 활성화
		ViewportSize:    ViewportBufferSize, // 뷰포트 버퍼 크기 (각각)
	},
	BufferTypeFileOnly: {
		Type:            BufferTypeFileOnly,
		MaxMemorySize:   100,                  // 최소한의 메모리 버퍼
		LogsDirectory:   "./logs/raw",
		FileMaxSize:     100 * 1024 * 1024,     // 100MB per file
		EnableIndexing:  true,
		ViewportSize:    ViewportBufferSize,    // 뷰포트 버퍼 크기
	},
}

// NewLogBufferWithConfig는 설정에 따라 적절한 LogBuffer를 생성합니다
func NewLogBufferWithConfig(config LogBufferConfig) LogBufferInterface {
	switch config.Type {
	case BufferTypeMemoryOnly:
		return NewMemoryLogBuffer(config.MaxMemorySize)
	case BufferTypeHybrid:
		return NewHybridLogBuffer(config)
	case BufferTypeFileOnly:
		// TODO: FileLogBuffer 구현 완료 후 활성화
		// return NewFileLogBuffer(config)
		// 임시로 HybridLogBuffer 반환
		return NewHybridLogBuffer(config)
	default:
		// 기본값은 메모리 전용
		return NewMemoryLogBuffer(DefaultMaxSize)
	}
}

// NewLogBufferByType은 타입에 따라 기본 설정으로 LogBuffer를 생성합니다
func NewLogBufferByType(bufferType LogBufferType) LogBufferInterface {
	config := DefaultConfigs[bufferType]
	return NewLogBufferWithConfig(config)
}
