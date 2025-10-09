package logviewer

import (
	"context"
	log "edgetool/util"
	_ "embed"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

//go:embed templates/index.html
var htmlTemplate string

//go:embed js/app.js
var jsTemplate string

//go:embed js/core/EventBus.js
var eventBusJS string

//go:embed js/core/AppState.js
var appStateJS string

//go:embed js/core/ModuleLoader.js
var moduleLoaderJS string

//go:embed js/modules/FilterManager.js
var filterManagerJS string

//go:embed js/modules/LogViewer.js
var logViewerJS string

//go:embed js/modules/WebSocketService.js
var webSocketServiceJS string

//go:embed js/modules/SearchManager.js
var searchManagerJS string

//go:embed js/modules/BookmarkManager.js
var bookmarkManagerJS string

//go:embed js/modules/HighlightManager.js
var highlightManagerJS string

//go:embed js/modules/TooltipManager.js
var tooltipManagerJS string

//go:embed js/utils/DebugLogger.js
var debugLoggerJS string

//go:embed templates/style.css
var cssTemplate string

// LogViewerConfig는 로그 뷰어 설정을 나타냅니다
type LogViewerConfig struct {
	Port              int              // 웹 서버 포트
	Host              string           // 웹 서버 호스트
	LocalBuffer       *HybridLogBuffer // 로컬 파일 모드용 버퍼
	ConnectionManager interface{}      // 실시간 모드용 연결 매니저
	Filter            string           // 로그 필터
	Mode              string           // "local-files" 또는 "realtime"
}

// LogViewer는 통합 로그 뷰어를 나타냅니다
type LogViewer struct {
	config    LogViewerConfig
	webViewer *WebLogViewer
}

// NewLogViewer는 새로운 통합 로그 뷰어를 생성합니다
func NewLogViewer(config LogViewerConfig) *LogViewer {
	var logBuffer LogBufferInterface

	if config.Mode == "local-files" && config.LocalBuffer != nil {
		// 로컬 파일 모드
		logBuffer = config.LocalBuffer
	} else {
		// 실시간 모드 - 빈 버퍼로 시작
		logBuffer = NewMemoryLogBuffer(1000)
	}

	webViewer := NewWebLogViewer(logBuffer)

	return &LogViewer{
		config:    config,
		webViewer: webViewer,
	}
}

// Start는 로그 뷰어를 시작합니다
func (lv *LogViewer) Start() {
	port := lv.config.Port
	if port == 0 {
		port = DEFAULT_WEB_SERVER_PORT
	}

	host := lv.config.Host
	if host == "" {
		host = "localhost"
	}

	// 웹 브라우저에서 열기
	url := fmt.Sprintf("http://%s:%d", host, port)
	log.Log(log.ColorGreen, "🌐 로그 뷰어가 시작되었습니다: %s\n", url)
	log.Log(log.ColorCyan, "브라우저에서 확인하세요. 종료하려면 Ctrl+C를 누르세요.\n")

	// 웹 브라우저 자동 열기는 WebLogViewer.Run()에서 처리하므로 여기서는 생략

	// 웹 서버 시작 (graceful shutdown 지원)
	lv.webViewer.Run(port)
}

// BroadcastBatchLogs는 모든 연결된 클라이언트에게 배치 로그를 전송합니다
func (lv *LogViewer) BroadcastBatchLogs(logs []LogEntry, mode string) {
	if lv.webViewer != nil {
		lv.webViewer.BroadcastBatchLogs(logs, mode)
	}
}

// openBrowserUrl는 기본 브라우저에서 URL을 엽니다 (기존과 다른 이름으로 생성)
func openBrowserUrl(url string) {
	var cmd string
	var args []string

	switch runtime.GOOS {
	case "windows":
		cmd = "cmd"
		args = []string{"/c", "start"}
	case "darwin":
		cmd = "open"
	default: // "linux", "freebsd", "openbsd", "netbsd"
		cmd = "xdg-open"
	}
	args = append(args, url)

	if err := exec.Command(cmd, args...).Start(); err != nil {
		log.Log(log.ColorYellow, "⚠️ 브라우저 자동 열기 실패: %v\n", err)
		log.Log(log.ColorCyan, "수동으로 브라우저에서 %s를 열어주세요.\n", url)
	}
}

// WebSocket 클라이언트 연결을 나타냅니다
type WebSocketClient struct {
	Conn     *websocket.Conn
	writeMux sync.Mutex // 각 연결별 쓰기 동기화
}

// WebLogViewer는 웹 기반 로그 뷰어를 나타냅니다 (LogBufferInterface 기반)
type WebLogViewer struct {
	LogBuffer  LogBufferInterface          `json:"-"`
	Router     *gin.Engine                 `json:"-"`
	Context    context.Context             `json:"-"`
	Cancel     context.CancelFunc          `json:"-"`
	Upgrader   websocket.Upgrader          `json:"-"`
	clients    map[string]*WebSocketClient `json:"-"` // WebSocket 클라이언트 연결들
	clientsMux sync.RWMutex                `json:"-"` // 클라이언트 맵 보호용 뮤텍스
	closeOnce  sync.Once                   `json:"-"` // Close() 메서드 동기화
}

// NewWebLogViewer는 새로운 웹 로그 뷰어를 생성합니다 (LogBufferInterface 기반)
func NewWebLogViewer(logBuffer LogBufferInterface) *WebLogViewer {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()

	ctx, cancel := context.WithCancel(context.Background())

	// WebSocket upgrader 설정
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true // 모든 origin 허용 (로컬 개발용)
		},
	}

	wlv := &WebLogViewer{
		LogBuffer: logBuffer,
		Router:    router,
		Context:   ctx,
		Cancel:    cancel,
		Upgrader:  upgrader,
		clients:   make(map[string]*WebSocketClient),
	}

	// 라우트 설정
	wlv.setupRoutes()

	return wlv
}

// setupRoutes는 웹 라우트를 설정합니다
func (wlv *WebLogViewer) setupRoutes() {
	// CORS 미들웨어 추가
	wlv.Router.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.Header("Pragma", "no-cache")
		c.Header("Expires", "0")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	wlv.Router.Use(gin.Recovery())
	wlv.Router.GET("/", wlv.serveIndex)
	wlv.Router.GET("/js/app.js", wlv.serveJS)
	wlv.Router.GET("/js/core/EventBus.js", wlv.serveEventBusJS)
	wlv.Router.GET("/js/core/AppState.js", wlv.serveAppStateJS)
	wlv.Router.GET("/js/core/ModuleLoader.js", wlv.serveModuleLoaderJS)
	wlv.Router.GET("/js/utils/DebugLogger.js", wlv.serveDebugLoggerJS)
	wlv.Router.GET("/js/modules/FilterManager.js", wlv.serveFilterManagerJS)
	wlv.Router.GET("/js/modules/LogViewer.js", wlv.serveLogViewerJS)
	wlv.Router.GET("/js/modules/WebSocketService.js", wlv.serveWebSocketServiceJS)
	wlv.Router.GET("/js/modules/SearchManager.js", wlv.serveSearchManagerJS)
	wlv.Router.GET("/js/modules/BookmarkManager.js", wlv.serveBookmarkManagerJS)
	wlv.Router.GET("/js/modules/HighlightManager.js", wlv.serveHighlightManagerJS)
	wlv.Router.GET("/js/modules/TooltipManager.js", wlv.serveTooltipManagerJS)
	wlv.Router.GET("/assets/css/style.css", wlv.serveCSS)
	wlv.Router.GET("/api/logs", wlv.getLogs)
	wlv.Router.GET("/ws", wlv.handleWebSocket)
}

// serveIndex는 메인 HTML 페이지를 제공합니다
func (wlv *WebLogViewer) serveIndex(c *gin.Context) {
	html := getHTMLTemplate()
	c.Header("Content-Type", "text/html")
	c.String(200, html)
}

// serveJS는 JavaScript 파일을 제공합니다
func (wlv *WebLogViewer) serveJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, jsTemplate)
}

// serveCSS는 CSS 파일을 제공합니다
func (wlv *WebLogViewer) serveCSS(c *gin.Context) {
	c.Header("Content-Type", "text/css")
	c.String(200, cssTemplate)
}

// JavaScript 파일 핸들러들
func (wlv *WebLogViewer) serveEventBusJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, eventBusJS)
}

func (wlv *WebLogViewer) serveAppStateJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, appStateJS)
}

func (wlv *WebLogViewer) serveModuleLoaderJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, moduleLoaderJS)
}

func (wlv *WebLogViewer) serveDebugLoggerJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, debugLoggerJS)
}

func (wlv *WebLogViewer) serveFilterManagerJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, filterManagerJS)
}

func (wlv *WebLogViewer) serveLogViewerJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, logViewerJS)
}

func (wlv *WebLogViewer) serveWebSocketServiceJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, webSocketServiceJS)
}

func (wlv *WebLogViewer) serveSearchManagerJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, searchManagerJS)
}

func (wlv *WebLogViewer) serveBookmarkManagerJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, bookmarkManagerJS)
}

func (wlv *WebLogViewer) serveHighlightManagerJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, highlightManagerJS)
}

func (wlv *WebLogViewer) serveTooltipManagerJS(c *gin.Context) {
	c.Header("Content-Type", "application/javascript")
	c.String(200, tooltipManagerJS)
}

// getLogs는 초기 로드용 로그를 반환합니다 (WebSocket 연결 전) - 스트리밍 방식으로 변경하여 빈 배열 반환
func (wlv *WebLogViewer) getLogs(c *gin.Context) {
	log.Log("🔍 [API] 초기 로그 요청 (스트리밍 모드: 빈 배열 반환)")

	// 스트리밍 방식: 초기 로드 없이 빈 배열 반환, WebSocket 연결 시점부터 로그 수신
	response := gin.H{
		"logs":  []*LogEntry{}, // 빈 배열로 시작
		"total": 0,
	}

	c.JSON(200, response)
}

// handleWebSocket는 WebSocket 연결을 처리합니다
func (wlv *WebLogViewer) handleWebSocket(c *gin.Context) {
	// HTTP 연결을 WebSocket으로 업그레이드
	conn, err := wlv.Upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Log("❌ WebSocket 업그레이드 실패: %v", err)
		return
	}
	defer conn.Close()

	log.Log("🔌 WebSocket 연결됨")

	// 클라이언트 ID 생성
	clientID := fmt.Sprintf("client_%d", time.Now().UnixNano())

	// 클라이언트 등록
	wlv.clientsMux.Lock()
	client := &WebSocketClient{
		Conn: conn,
	}
	wlv.clients[clientID] = client
	wlv.clientsMux.Unlock()
	defer func() {
		wlv.clientsMux.Lock()
		delete(wlv.clients, clientID)
		wlv.clientsMux.Unlock()
	}()

	// LogBuffer 구독
	logChan := wlv.LogBuffer.Subscribe(clientID)
	defer wlv.LogBuffer.Unsubscribe(clientID, logChan)

	// 📋 놓친 로그 즉시 복구 (연결 시점)
	missedLogs := wlv.LogBuffer.GetNewLogs(clientID)
	if len(missedLogs) > 0 {
		log.Log("🔄 [Recovery] 클라이언트 %s 놓친 로그 복구: %d개", clientID, len(missedLogs))

		// 버퍼 통계에서 총 로그 수 가져오기
		stats := wlv.LogBuffer.GetStats()
		totalLogs, _ := stats["total_logs"].(int64)
		if totalLogs == 0 {
			// int64로 캐스팅 실패 시 int로 시도
			if totalLogsInt, ok := stats["total_logs"].(int); ok {
				totalLogs = int64(totalLogsInt)
			}
		}

		for _, missedLog := range missedLogs {
			update := map[string]interface{}{
				"type":      "recovery_log",
				"log":       missedLog,
				"totalLogs": totalLogs,
			}
			client.writeMux.Lock()
			if err := conn.WriteJSON(update); err != nil {
				client.writeMux.Unlock()
				log.Log("❌ 복구 로그 전송 실패: %v", err)
				return
			}
			client.writeMux.Unlock()
			wlv.LogBuffer.MarkConsumed(clientID, missedLog.ID)
		}
		log.Log("✅ [Recovery] 클라이언트 %s 복구 완료", clientID)
	}

	// 📡 주기적 동기화 타이머 (5초마다)
	syncTicker := time.NewTicker(5 * time.Second)
	defer syncTicker.Stop()

	// 연결 확인 메시지 전송
	client.writeMux.Lock()
	if err := conn.WriteJSON(LogUpdate{
		Type: "connected",
		Data: gin.H{"message": "WebSocket 연결 성공", "client_id": clientID},
	}); err != nil {
		client.writeMux.Unlock()
		log.Log("❌ 연결 메시지 전송 실패: %v", err)
		return
	}
	client.writeMux.Unlock()

	// 클라이언트 메시지 처리
	go func() {
		for {
			var msg map[string]interface{}
			if err := conn.ReadJSON(&msg); err != nil {
				log.Log("🔌 WebSocket 연결 종료: %v", err)
				return
			}

			// 메시지 타입별 처리
			if msgType, ok := msg["type"].(string); ok {
				switch msgType {
				case "debug_log":
					// JavaScript 디버그 로그를 Go 서버 콘솔에 출력
					level, levelOk := msg["level"].(string)
					message, messageOk := msg["message"].(string)

					if levelOk && messageOk {
						// 레벨별 아이콘
						var icon string
						switch level {
						case "debug":
							icon = "🐛"
						case "info":
							icon = "ℹ️"
						case "warn":
							icon = "⚠️"
						case "error":
							icon = "❌"
						default:
							icon = "📝"
						}

						log.Log("%s [JS] %s: %s\n", icon, level, message)
					}
				case "range_request":
					// 범위 기반 로그 요청 처리
					minIndex, minOk := msg["min_index"].(float64)
					maxIndex, maxOk := msg["max_index"].(float64)
					reason, reasonOk := msg["reason"].(string)

					if minOk && maxOk {
						logs := wlv.LogBuffer.GetLogsInRange(int64(minIndex), int64(maxIndex))

						// 버퍼 통계에서 총 로그 수 가져오기
						stats := wlv.LogBuffer.GetStats()
						totalLogs, _ := stats["total_logs"].(int64)
						if totalLogs == 0 {
							// int64로 캐스팅 실패 시 int로 시도
							if totalLogsInt, ok := stats["total_logs"].(int); ok {
								totalLogs = int64(totalLogsInt)
							}
						}

						response := map[string]interface{}{
							"type":      "range_response",
							"startId":   int64(minIndex),
							"endId":     int64(maxIndex),
							"logs":      logs,
							"count":     len(logs),
							"totalLogs": totalLogs,
						}

						// reason이 있으면 응답에 포함
						if reasonOk {
							response["reason"] = reason
						}

						client.writeMux.Lock()
						if err := conn.WriteJSON(response); err != nil {
							client.writeMux.Unlock()
							log.Log("❌ 범위 로그 전송 실패: %v", err)
							return
						}
						client.writeMux.Unlock()
					}
				case "scroll_request":
					// 스크롤 위치 기반 로그 요청 처리
					scrollTop, scrollTopOk := msg["scroll_top"].(float64)
					viewportHeight, viewportHeightOk := msg["viewport_height"].(float64)
					totalHeight, totalHeightOk := msg["total_height"].(float64)

					if scrollTopOk && viewportHeightOk && totalHeightOk {
						log.Log("📜 [WebSocket] 스크롤 요청 수신: %.1fpx/%.1fpx (%.1f%%)\n", scrollTop, totalHeight, (scrollTop/totalHeight)*100)
						logs := wlv.LogBuffer.GetLogsByScrollPosition(scrollTop, viewportHeight, totalHeight)

						// 버퍼 통계에서 총 로그 수 가져오기
						stats := wlv.LogBuffer.GetStats()
						totalLogs, _ := stats["total_logs"].(int64)
						if totalLogs == 0 {
							// int64로 캐스팅 실패 시 int로 시도
							if totalLogsInt, ok := stats["total_logs"].(int); ok {
								totalLogs = int64(totalLogsInt)
							}
						}

						response := map[string]interface{}{
							"type":            "scroll_response",
							"scroll_top":      scrollTop,
							"viewport_height": viewportHeight,
							"total_height":    totalHeight,
							"logs":            logs,
							"count":           len(logs),
							"totalLogs":       totalLogs,
						}

						client.writeMux.Lock()
						if err := conn.WriteJSON(response); err != nil {
							client.writeMux.Unlock()
							log.Log("❌ 스크롤 로그 전송 실패: %v", err)
							return
						}
						client.writeMux.Unlock()

						log.Log("🎯 스크롤 로그 전송: %.1fpx/%.1fpx (%.1f%%) (%d개)",
							scrollTop, totalHeight, (scrollTop/totalHeight)*100, len(logs))
					}
				case "search_request":
					// 검색 요청 처리
					keyword, keywordOk := msg["keyword"].(string)

					if keywordOk && keyword != "" {
						logs := wlv.LogBuffer.Search(keyword)

						// 버퍼 통계에서 총 로그 수 가져오기
						stats := wlv.LogBuffer.GetStats()
						totalLogs, _ := stats["total_logs"].(int64)
						if totalLogs == 0 {
							// int64로 캐스팅 실패 시 int로 시도
							if totalLogsInt, ok := stats["total_logs"].(int); ok {
								totalLogs = int64(totalLogsInt)
							}
						}

						response := map[string]interface{}{
							"type":        "search_response",
							"keyword":     keyword,
							"results":     logs,
							"count":       len(logs),
							"search_mode": true,
							"totalLogs":   totalLogs,
						}

						client.writeMux.Lock()
						if err := conn.WriteJSON(response); err != nil {
							client.writeMux.Unlock()
							log.Log("❌ 검색 응답 전송 실패: %v", err)
							return
						}
						client.writeMux.Unlock()

						log.Log("🔍 검색 완료: '%s' (%d개 발견)", keyword, len(logs))
					} else {
						log.Log("❌ 검색 요청 파라미터 오류")
					}
				case "exit_search":
					// 검색 모드 종료
					wlv.LogBuffer.ExitSearchMode()

					response := map[string]interface{}{
						"type":        "search_exit",
						"search_mode": false,
					}

					client.writeMux.Lock()
					if err := conn.WriteJSON(response); err != nil {
						client.writeMux.Unlock()
						log.Log("❌ 검색 종료 응답 전송 실패: %v", err)
						return
					}
					client.writeMux.Unlock()

					log.Log("✅ 검색 모드 종료")
				default:
					// 기타 메시지는 단순 로그
					log.Log("📨 클라이언트 메시지: %v", msg)
				}
			}
		}
	}()

	// LogBuffer에서 새 로그 엔트리를 클라이언트로 전송
	for {
		select {
		case logEntry, ok := <-logChan:
			if !ok {
				log.Log("🔌 LogBuffer 로그 채널 닫힘")
				return
			}

			// 버퍼 통계에서 총 로그 수 가져오기
			stats := wlv.LogBuffer.GetStats()
			totalLogs, _ := stats["total_logs"].(int64)
			if totalLogs == 0 {
				// int64로 캐스팅 실패 시 int로 시도
				if totalLogsInt, ok := stats["total_logs"].(int); ok {
					totalLogs = int64(totalLogsInt)
				}
			}

			// 로그와 총 로그 수 함께 전송
			update := map[string]interface{}{
				"type":      "new_log",
				"log":       logEntry,
				"totalLogs": totalLogs,
			}

			// WebSocket 쓰기 동기화
			client.writeMux.Lock()
			err := conn.WriteJSON(update)
			client.writeMux.Unlock()

			if err != nil {
				log.Log("❌ 로그 전송 실패: %v", err)
				return
			}

			// 전송 완료된 로그 마킹 (버퍼에서 제거 트리거)
			wlv.LogBuffer.MarkConsumed(clientID, logEntry.ID)

		case <-syncTicker.C:
			// 📡 주기적 동기화: 놓친 로그 재전송
			syncLogs := wlv.LogBuffer.GetNewLogs(clientID)
			if len(syncLogs) > 0 {
				log.Log("🔄 [Sync] 클라이언트 %s 동기화: %d개 로그", clientID, len(syncLogs))

				// 버퍼 통계에서 총 로그 수 가져오기
				stats := wlv.LogBuffer.GetStats()
				totalLogs, _ := stats["total_logs"].(int64)
				if totalLogs == 0 {
					// int64로 캐스팅 실패 시 int로 시도
					if totalLogsInt, ok := stats["total_logs"].(int); ok {
						totalLogs = int64(totalLogsInt)
					}
				}

				for _, syncLog := range syncLogs {
					update := map[string]interface{}{
						"type":      "sync_log",
						"log":       syncLog,
						"totalLogs": totalLogs,
					}
					client.writeMux.Lock()
					if err := conn.WriteJSON(update); err != nil {
						client.writeMux.Unlock()
						log.Log("❌ 동기화 로그 전송 실패: %v", err)
						return
					}
					client.writeMux.Unlock()
					wlv.LogBuffer.MarkConsumed(clientID, syncLog.ID)
				}
			}

		case <-wlv.Context.Done():
			log.Log("🔌 컨텍스트 취소됨")
			return
		}
	}
}

// Close는 웹 로그 뷰어를 종료합니다
func (wlv *WebLogViewer) Close() {
	wlv.closeOnce.Do(func() {
		if wlv.LogBuffer != nil {
			wlv.LogBuffer.Close()
		}
		wlv.Cancel()
	})
}

// Run은 웹 서버를 시작합니다
func (wlv *WebLogViewer) Run(port int) {
	portStr := fmt.Sprintf("%d", port)

	log.Log(log.ColorGreen, "🌐 LogBuffer 기반 로그 뷰어가 시작되었습니다: http://localhost:%s", portStr)
	log.Log(log.ColorCyan, "🚀 WebSocket 기반 실시간 스트리밍 활성화")
	log.Log(log.ColorYellow, "💡 종료하려면 Ctrl+C를 누르세요")

	// Gin 서버를 http.Server로 래핑하여 graceful shutdown 지원
	srv := &http.Server{
		Addr:    ":" + portStr,
		Handler: wlv.Router,
	}

	// 서버를 고루틴에서 시작
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Log("❌ 서버 시작 실패: %v", err)
		}
	}()

	// 브라우저 열기를 별도 고루틴에서 실행
	go func() {
		time.Sleep(1 * time.Second) // 서버가 완전히 시작될 때까지 대기
		openBrowser("http://localhost:" + portStr)
	}()

	// 시그널 채널 생성 (Windows에서는 os.Interrupt 사용)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)

	// 시그널 대기
	<-quit
	log.Log(log.ColorYellow, "🛑 종료 시그널 수신됨, 서버를 정상적으로 종료합니다...")

	// Context를 사용한 graceful shutdown (최대 5초 대기)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Log(log.ColorRed, "❌ 서버 강제 종료: %v", err)
		srv.Close() // 강제 종료
	}

	// 리소스 정리
	wlv.Close()
	log.Log(log.ColorGreen, "✅ 서버가 정상적으로 종료되었습니다")
}

// openBrowser는 기본 브라우저로 URL을 엽니다
func openBrowser(url string) {
	var err error

	log.Log("🌐 기본 브라우저로 로그 뷰어 열기: %s\n", url)

	switch runtime.GOOS {
	case "windows":
		err = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "linux":
		err = exec.Command("xdg-open", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	default:
		log.Log("💡 브라우저에서 직접 접속하세요: %s\n", url)
		return
	}

	if err != nil {
		log.Log("❌ 브라우저 열기 실패: %v\n", err)
		log.Log("💡 브라우저에서 직접 접속하세요: %s\n", url)
	} else {
		log.Log("🎯 기본 브라우저로 열림: %s\n", url)
	}
}

// getHTMLTemplate는 웹 UI의 HTML 템플릿을 반환합니다
func getHTMLTemplate() string {
	return htmlTemplate
}

// BroadcastBatchLogs는 모든 연결된 클라이언트에게 배치 로그를 전송합니다
func (wlv *WebLogViewer) BroadcastBatchLogs(logs []LogEntry, mode string) {
	if len(logs) == 0 {
		return
	}

	wlv.clientsMux.RLock()
	clientCount := len(wlv.clients)
	wlv.clientsMux.RUnlock()

	log.Log("📊 웹 클라이언트 배치 전송 시작: %d개 로그 → %d개 클라이언트", len(logs), clientCount)

	// 버퍼 통계에서 총 로그 수 가져오기
	stats := wlv.LogBuffer.GetStats()
	totalLogs, _ := stats["total_logs"].(int64)
	if totalLogs == 0 {
		// int64로 캐스팅 실패 시 int로 시도
		if totalLogsInt, ok := stats["total_logs"].(int); ok {
			totalLogs = int64(totalLogsInt)
		}
	}
	log.Log("📊 [WebSocket] batch_logs 전송: totalLogs=%d, stats=%v", totalLogs, stats)

	batchMessage := map[string]interface{}{
		"type":      "batch_logs",
		"logs":      logs,
		"count":     len(logs),
		"totalLogs": totalLogs,
		"mode":      mode,
	}

	sentCount := 0
	wlv.clientsMux.RLock()
	// 클라이언트 맵 복사 (동시성 문제 방지)
	clientsCopy := make(map[string]*WebSocketClient)
	for clientID, client := range wlv.clients {
		clientsCopy[clientID] = client
	}
	wlv.clientsMux.RUnlock()

	// 복사된 클라이언트 맵으로 순차 전송
	for clientID, client := range clientsCopy {
		client.writeMux.Lock()
		err := client.Conn.WriteJSON(batchMessage)
		client.writeMux.Unlock()

		if err != nil {
			log.Log("❌ 배치 로그 전송 실패 (%s): %v", clientID, err)
		} else {
			log.Log("📦 배치 로그 전송 (%s): %d개", clientID, len(logs))
			sentCount++
		}
	}

	log.Log("✅ 웹 클라이언트 배치 전송 완료: %d개 클라이언트에 %d개 로그 전송", sentCount, len(logs))
}

// ShowLogViewer는 웹 로그 뷰어를 표시합니다 (LogBufferInterface 기반)
func ShowLogViewer(logBuffer LogBufferInterface) {
	viewer := NewWebLogViewer(logBuffer)
	viewer.Run(DEFAULT_WEB_SERVER_PORT) // 기본 포트 사용
}

// ShowLogViewerWithBuffer는 웹 로그 뷰어를 표시합니다 (하위 호환성용)
func ShowLogViewerWithBuffer(logBuffer *MemoryLogBuffer) {
	ShowLogViewer(logBuffer)
}
