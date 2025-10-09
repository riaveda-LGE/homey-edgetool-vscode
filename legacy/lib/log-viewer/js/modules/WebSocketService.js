/**
 * WebSocketService 모듈
 * 
 * WebSocket 연결 관리 및 메시지 처리
 * 재연결, 상태 관리, 메시지 라우팅 담당
 */

export default class WebSocketService {
    constructor({ eventBus, appState }) {
        this.eventBus = eventBus;
        this.appState = appState;
        
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        
        // 배치 처리를 위한 버퍼
        this.logBatch = [];
        this.batchSize = 50;
        this.batchTimeout = null;
        this.batchDelay = 100; // 100ms 지연
    }

    /**
     * 모듈 초기화
     */
    async init() {
        this.connect();
        
        // 메시지 전송 이벤트 구독
        this.eventBus.subscribe('websocket:send', (message) => {
            this.send(message);
        });
        
        console.log('[WebSocketService] 모듈 초기화 완료');
    }

    /**
     * WebSocket 연결
     */
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        console.log('[WebSocketService] 연결 시도:', wsUrl);
        this.appState.set('connection.status', 'connecting');
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('[WebSocketService] 연결 성공');
            this.appState.set('connection.status', 'connected');
            this.appState.set('connection.lastConnected', new Date().toISOString());
            this.reconnectAttempts = 0;
            
            this.eventBus.publish('websocket:connected', { url: wsUrl });
            
            // 연결 후 바로 로그 수신 시작 (ready 메시지 제거)
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (error) {
                console.error('[WebSocketService] 메시지 파싱 실패:', error);
                this.eventBus.publish('websocket:parse-error', { error, raw: event.data });
            }
        };
        
        this.ws.onclose = () => {
            console.log('[WebSocketService] 연결 종료');
            this.appState.set('connection.status', 'disconnected');
            
            this.eventBus.publish('websocket:disconnected', {});
            
            // 자동 재연결 시도
            this.attemptReconnect();
        };
        
        this.ws.onerror = (error) => {
            console.error('[WebSocketService] 연결 오류:', error);
            this.appState.set('connection.status', 'error');
            
            this.eventBus.publish('websocket:error', { error });
        };
    }

    /**
     * 메시지 처리 (배치 지원 추가)
     */
    handleMessage(data) {
        // 중요하지 않은 로그는 제거
        // console.log('[WebSocketService] 📨 메시지 받음:', data);
        
        if (data.type === 'connected') {
            console.log('[WebSocketService] 연결 확인:', data.data.message);
            return;
        }
        
        if (data.type === 'new_log') {
            // 단일 로그에 totalLogs 정보 추가
            const logEntry = data.log || data.data;
            if (data.totalLogs !== undefined) {
                logEntry.totalLogs = data.totalLogs;
            }
            // 배치 처리로 성능 최적화
            this.addLogToBatch(logEntry);
            return;
        }

        if (data.type === 'recovery_log') {
            // 복구된 로그는 즉시 처리 (중요함)
            const logEntry = data.log || data.data;
            if (data.totalLogs !== undefined) {
                logEntry.totalLogs = data.totalLogs;
            }
            this.eventBus.publish('log:received', logEntry);
            return;
        }

        if (data.type === 'sync_log') {
            // 동기화 로그는 배치 처리
            const logEntry = data.log || data.data;
            if (data.totalLogs !== undefined) {
                logEntry.totalLogs = data.totalLogs;
            }
            this.addLogToBatch(logEntry);
            return;
        }

        if (data.type === 'batch_logs') {
            // 서버 배치 로그는 즉시 배치 처리
            const batchData = {
                logs: data.logs || [],
                count: data.count || data.logs.length,
                totalLogs: data.totalLogs,
                mode: data.mode  // 서버에서 전송한 모드 정보
            };
            this.eventBus.publish('log:batch_received', batchData);
            return;
        }

        if (data.type === 'scroll_logs') {
            // 스크롤 요청에 대한 응답 로그
            data.logs.forEach(logEntry => {
                this.addLogToBatch(logEntry);
            });
            return;
        }

        if (data.type === 'range_response') {
            // 범위 응답은 즉시 처리
            this.eventBus.publish('log:range_received', {
                logs: data.logs || [],
                count: data.count || data.logs.length,
                startId: data.startId,
                endId: data.endId,
                totalLogs: data.totalLogs,
                reason: data.reason
            });
            return;
        }
        
        // 기타 메시지 타입 처리 (중요한 것만)
        this.eventBus.publish('websocket:message', data);
    }

    /**
     * 로그 배치 처리 추가
     */
    addLogToBatch(logEntry) {
        this.logBatch.push(logEntry);
        
        // 배치 크기 도달 시 즉시 플러시
        if (this.logBatch.length >= this.batchSize) {
            this.flushLogBatch();
            return;
        }
        
        // 타이머 설정 (지연 플러시)
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
        }
        
        this.batchTimeout = setTimeout(() => {
            this.flushLogBatch();
        }, this.batchDelay);
    }

    /**
     * 배치 로그 플러시
     */
    flushLogBatch() {
        if (this.logBatch.length === 0) return;
        
        // 마지막 로그에서 totalLogs 추출 (모든 로그가 같은 totalLogs를 가짐)
        const lastLog = this.logBatch[this.logBatch.length - 1];
        const totalLogs = lastLog && typeof lastLog.totalLogs === 'number' ? lastLog.totalLogs : undefined;
        
        // 배치로 한 번에 발행
        this.eventBus.publish('log:batch_received', {
            logs: [...this.logBatch],
            count: this.logBatch.length,
            totalLogs: totalLogs
        });
        
        // 배치 초기화
        this.logBatch = [];
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = null;
        }
    }

    /**
     * 재연결 시도
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[WebSocketService] 최대 재연결 시도 횟수 초과');
            this.appState.set('connection.status', 'failed');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;
        
        console.log(`[WebSocketService] ${delay}ms 후 재연결 시도 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        setTimeout(() => {
            this.connect();
        }, delay);
    }

    /**
     * 메시지 전송
     */
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        } else {
            console.warn('[WebSocketService] 연결되지 않음 - 메시지 전송 실패');
            return false;
        }
    }

    /**
     * 연결 종료
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.appState.set('connection.status', 'disconnected');
    }

    /**
     * 연결 상태 확인
     */
    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * 디버그 로그를 서버로 전송
     */
    sendDebugLog(level, message) {
        if (this.isConnected()) {
            this.send({
                type: 'debug_log',
                level: level,
                message: message,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * 모듈 정리
     */
    async destroy() {
        this.disconnect();
        console.log('[WebSocketService] 모듈 정리 완료');
    }
}
