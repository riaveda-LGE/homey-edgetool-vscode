/**
 * Edge Tool - 로그 뷰어 메인 애플리케이션
 * 
 * 모듈러 아키텍처 기반
 * - EventBus: 중앙집중식 이벤트 시스템
 * - AppState: 전역 상태 관리
 * - ModuleLoader: 동적 모듈 로딩
 * 
 * 깔끔하고 확장 가능한 구조
 */

class Application {
    constructor() {
        this.eventBus = null;
        this.appState = null;
        this.moduleLoader = null;
        this.coreModules = [];
        this.initialized = false;
        
        console.log('[Application] 생성자 호출');
    }

    /**
     * 애플리케이션 초기화
     */
    async init() {
        console.log('[Application] 초기화 시작');

        // 1단계: 핵심 아키텍처 초기화
        await this.initCoreArchitecture();

        // 2단계: 핵심 모듈들 로드
        await this.loadCoreModules();

        // 3단계: UI 초기화
        this.initUI();

        // 4단계: 이벤트 바인딩
        this.bindEvents();

        this.initialized = true;
        console.log('[Application] 초기화 완료');

        // 초기화 완료 이벤트 발행
        this.eventBus.publish('app:initialized', {
            timestamp: Date.now(),
            modules: this.coreModules
        });
    }

    /**
     * 핵심 아키텍처 초기화
     */
    async initCoreArchitecture() {
        console.log('[Application] 핵심 아키텍처 초기화 중...');

        // EventBus 생성
        const { default: EventBus } = await import('/js/core/EventBus.js');
        this.eventBus = new EventBus();
        this.eventBus.setDebug(true);

        // AppState 생성
        const { default: AppState } = await import('/js/core/AppState.js');
        this.appState = new AppState(this.eventBus);
        this.appState.setDebug(true);

        // ModuleLoader 생성
        const { default: ModuleLoader } = await import('/js/core/ModuleLoader.js');
        this.moduleLoader = new ModuleLoader(this.eventBus, this.appState);
        this.moduleLoader.setDebug(true);

        console.log('[Application] 핵심 아키텍처 초기화 완료');
    }

    /**
     * 핵심 모듈들 로드
     */
    async loadCoreModules() {
        console.log('[Application] 🚀 핵심 모듈 로딩 시작');

        try {
            // DebugLogger 유틸리티 로드 (자동 로딩되지만 명시적으로)
            console.log('[Application] 🐛 DebugLogger 로딩 중...');
            const debugLogger = await this.moduleLoader.loadModule('DebugLogger');
            console.log('[Application] ✅ DebugLogger 로딩 완료');

            // WebSocket 서비스 로드
            console.log('[Application] 🌐 WebSocketService 로딩 중...');
            const webSocketService = await this.moduleLoader.loadModule('WebSocketService');
            
            // DebugLogger에 WebSocketService 연결
            debugLogger.setWebSocketService(webSocketService);
            
            // 전역 console 오버라이드 활성화 (선택사항)
            debugLogger.overrideConsole();
            
            console.log('[Application] ✅ WebSocketService 로딩 완료');
            
            // 필터 매니저 로드
            console.log('[Application] 🔍 FilterManager 로딩 중...');
            const filterManager = await this.moduleLoader.loadModule('FilterManager');
            window.filterManager = filterManager; // UI에서 접근용
            console.log('[Application] ✅ FilterManager 로딩 완료');
            
            // 로그 뷰어 로드
            console.log('[Application] 📊 LogViewer 로딩 중...');
            const logViewer = await this.moduleLoader.loadModule('LogViewer');
            console.log('[Application] ✅ LogViewer 로딩 완료');

            // 검색 매니저 로드
            console.log('[Application] 🔍 SearchManager 로딩 중...');
            const searchManager = await this.moduleLoader.loadModule('SearchManager');
            console.log('[Application] ✅ SearchManager 로딩 완료');

            // 북마크 매니저 로드
            console.log('[Application] 📖 BookmarkManager 로딩 중...');
            const bookmarkManager = await this.moduleLoader.loadModule('BookmarkManager');
            console.log('[Application] ✅ BookmarkManager 로딩 완료');

            // 하이라이트 매니저 로드
            console.log('[Application] 🎨 HighlightManager 로딩 중...');
            const highlightManager = await this.moduleLoader.loadModule('HighlightManager');
            console.log('[Application] ✅ HighlightManager 로딩 완료');

            // 툴팁 매니저 로드
            console.log('[Application] 💬 TooltipManager 로딩 중...');
            const tooltipManager = await this.moduleLoader.loadModule('TooltipManager');
            console.log('[Application] ✅ TooltipManager 로딩 완료');

            this.coreModules = [
                'WebSocketService',
                'FilterManager',
                'LogViewer',
                'SearchManager',
                'BookmarkManager',
                'HighlightManager',
                'TooltipManager'
            ];

            console.log('[Application] ✅ 핵심 모듈 로딩 완료:', this.coreModules);
        } catch (error) {
            console.error('[Application] ❌ 모듈 로딩 실패:', error);
            throw error;
        }
    }

    /**
     * UI 초기화
     */
    initUI() {
        console.log('[Application] UI 초기화 시작');

        // 상태에서 UI 설정 복원
        const uiState = this.appState.get('ui');
        if (uiState) {
            document.body.className = `theme-${uiState.theme || 'dark'}`;
            if (uiState.fontSize) {
                document.body.style.fontSize = `${uiState.fontSize}px`;
            }
        }

        // 스크롤 버튼 이벤트
        const scrollBtn = document.getElementById('scrollToBottomBtn');
        if (scrollBtn) {
            scrollBtn.addEventListener('click', () => {
                this.eventBus.publish('ui:scroll-to-bottom', {});
            });
        }

        console.log('[Application] UI 초기화 완료');
    }

    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        console.log('[Application] 이벤트 바인딩 시작');

        // 애플리케이션 종료 이벤트
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });

        // 에러 핸들링
        this.eventBus.subscribe('system:error', (error) => {
            this.handleError(error);
        });

        // 상태 변경 감지
        this.appState.watch('ui.theme', (newTheme) => {
            document.body.className = `theme-${newTheme}`;
            console.log(`[Application] 테마 변경: ${newTheme}`);
        });

        // 백업용 전역 스크롤 감지 (LogViewer가 처리하지 못하는 경우 대비)
        document.addEventListener('scroll', () => {
            // 로그 컨테이너가 있으면 LogViewer가 처리하므로 전역 처리는 건너뜀
            const logContainer = document.getElementById('log-container');
            if (logContainer) return;
            
            const isAtBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 100;
            this.appState.set('logs.autoScroll', isAtBottom);
            
            const scrollBtn = document.getElementById('scrollToBottomBtn');
            if (scrollBtn) {
                scrollBtn.style.display = isAtBottom ? 'none' : 'block';
            }
        });

        console.log('[Application] 이벤트 바인딩 완료');
    }

    /**
     * 에러 처리
     */
    handleError(error) {
        console.error('[Application] 시스템 에러:', error);
        
        // 에러 상태 업데이트
        this.appState.set('connection.status', 'error');
    }

    /**
     * 정리 작업
     */
    cleanup() {
        console.log('[Application] 정리 작업 시작');
        
        if (this.moduleLoader) {
            this.moduleLoader.unloadAll();
        }
        
        this.appState.saveToStorage();
        
        console.log('[Application] 정리 작업 완료');
    }
}

// ========================================
// 애플리케이션 시작
// ========================================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM 로드 완료 - 애플리케이션 시작');
    
    const app = new Application();
    await app.init();
    
    console.log('Edge Tool 애플리케이션 시작 완료');
});
