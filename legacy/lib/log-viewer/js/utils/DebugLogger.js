/**
 * DebugLogger - 공통 디버그 로깅 유틸리티
 * 
 * 모든 JavaScript 모듈에서 사용 가능한 디버그 로깅 시스템
 * 웹 콘솔과 Go 서버로 동시에 로그 전송
 */

export default class DebugLogger {
    constructor() {
        this.webSocketService = null;
        this.modulePrefix = '';
        this.isEnabled = true;
    }

    /**
     * WebSocketService 설정 (ModuleLoader에서 자동 설정)
     */
    setWebSocketService(webSocketService) {
        this.webSocketService = webSocketService;
    }

    /**
     * 모듈명 설정 (로그 앞에 붙일 prefix)
     */
    setModulePrefix(prefix) {
        this.modulePrefix = prefix;
    }

    /**
     * 디버그 로깅 활성화/비활성화
     */
    setEnabled(enabled) {
        this.isEnabled = enabled;
    }

    /**
     * 디버그 로그를 웹 콘솔과 서버로 전송
     */
    log(level, message, ...args) {
        if (!this.isEnabled) return;

        const fullMessage = this.modulePrefix ? `[${this.modulePrefix}] ${message}` : message;
        
        // 웹 콘솔에 출력 (백업 및 즉시 확인용)
        switch (level) {
            case 'error':
                console.error(fullMessage, ...args);
                break;
            case 'warn':
                console.warn(fullMessage, ...args);
                break;
            case 'info':
                console.info(fullMessage, ...args);
                break;
            case 'debug':
            default:
                console.log(fullMessage, ...args);
                break;
        }

        // 서버로 전송 (WebSocket 연결이 있을 때만)
        if (this.webSocketService && this.webSocketService.isConnected()) {
            this.webSocketService.sendDebugLog(level, fullMessage);
        }
    }

    /**
     * 편의 메서드들
     */
    debug(message, ...args) {
        this.log('debug', message, ...args);
    }

    info(message, ...args) {
        this.log('info', message, ...args);
    }

    warn(message, ...args) {
        this.log('warn', message, ...args);
    }

    error(message, ...args) {
        this.log('error', message, ...args);
    }

    /**
     * 전역 console 오버라이드 (선택적으로 사용)
     */
    overrideConsole() {
        if (!this.isEnabled) return;

        const originalConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug
        };

        // console.log 오버라이드
        console.log = (...args) => {
            originalConsole.log(...args);
            if (this.webSocketService && this.webSocketService.isConnected()) {
                const message = args.map(arg => 
                    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                ).join(' ');
                this.webSocketService.sendDebugLog('debug', `[Console] ${message}`);
            }
        };

        // console.info 오버라이드
        console.info = (...args) => {
            originalConsole.info(...args);
            if (this.webSocketService && this.webSocketService.isConnected()) {
                const message = args.map(arg => 
                    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                ).join(' ');
                this.webSocketService.sendDebugLog('info', `[Console] ${message}`);
            }
        };

        // console.warn 오버라이드
        console.warn = (...args) => {
            originalConsole.warn(...args);
            if (this.webSocketService && this.webSocketService.isConnected()) {
                const message = args.map(arg => 
                    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                ).join(' ');
                this.webSocketService.sendDebugLog('warn', `[Console] ${message}`);
            }
        };

        // console.error 오버라이드
        console.error = (...args) => {
            originalConsole.error(...args);
            if (this.webSocketService && this.webSocketService.isConnected()) {
                const message = args.map(arg => 
                    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                ).join(' ');
                this.webSocketService.sendDebugLog('error', `[Console] ${message}`);
            }
        };

        // console.debug 오버라이드
        console.debug = (...args) => {
            originalConsole.debug(...args);
            if (this.webSocketService && this.webSocketService.isConnected()) {
                const message = args.map(arg => 
                    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                ).join(' ');
                this.webSocketService.sendDebugLog('debug', `[Console] ${message}`);
            }
        };

        // 원본 복원 함수 반환
        return () => {
            console.log = originalConsole.log;
            console.info = originalConsole.info;
            console.warn = originalConsole.warn;
            console.error = originalConsole.error;
            console.debug = originalConsole.debug;
        };
    }
}

// 전역 싱글톤 인스턴스 생성
export const debugLogger = new DebugLogger();
