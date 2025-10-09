/**
 * EventBus - 중앙집중식 이벤트 시스템
 * 
 * 모든 컴포넌트 간 통신을 담당하는 핵심 모듈
 * 네임스페이스 지원, 에러 처리, 디버깅 기능 포함
 */

export default class EventBus {
    constructor() {
        this.events = new Map();
        this.debug = false;
        this.stats = {
            published: 0,
            subscribed: 0,
            errors: 0
        };
    }

    /**
     * 디버그 모드 설정
     */
    setDebug(enabled) {
        this.debug = enabled;
        if (enabled) {
            console.log('[EventBus] 디버그 모드 활성화');
        }
    }

    /**
     * 이벤트 구독
     */
    subscribe(eventName, callback) {
        if (!this.events.has(eventName)) {
            this.events.set(eventName, new Set());
        }
        
        this.events.get(eventName).add(callback);
        this.stats.subscribed++;
        
        if (this.debug) {
            console.log(`[EventBus] 구독: ${eventName}`);
        }
        
        // 구독 해제 함수 반환
        return () => this.unsubscribe(eventName, callback);
    }

    /**
     * 이벤트 구독 해제
     */
    unsubscribe(eventName, callback) {
        if (this.events.has(eventName)) {
            this.events.get(eventName).delete(callback);
            
            // 구독자가 없으면 이벤트 삭제
            if (this.events.get(eventName).size === 0) {
                this.events.delete(eventName);
            }
        }
        
        if (this.debug) {
            console.log(`[EventBus] 구독 해제: ${eventName}`);
        }
    }

    /**
     * 이벤트 발행
     */
    publish(eventName, data = null) {
        if (!this.events.has(eventName)) {
            return;
        }
        
        const callbacks = this.events.get(eventName);
        this.stats.published++;
        
        callbacks.forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                this.stats.errors++;
                console.error(`[EventBus] 이벤트 처리 오류 (${eventName}):`, error);
                
                // 시스템 에러 이벤트 발행 (무한 루프 방지)
                if (eventName !== 'system:error') {
                    this.publish('system:error', { eventName, error, data });
                }
            }
        });
    }

    /**
     * 모든 이벤트 구독 해제
     */
    clear() {
        this.events.clear();
        if (this.debug) {
            console.log('[EventBus] 모든 이벤트 구독 해제');
        }
    }

    /**
     * 통계 정보 반환
     */
    getStats() {
        return {
            ...this.stats,
            activeEvents: this.events.size,
            totalSubscribers: Array.from(this.events.values())
                .reduce((sum, callbacks) => sum + callbacks.size, 0)
        };
    }

    /**
     * 현재 등록된 이벤트 목록
     */
    getRegisteredEvents() {
        return Array.from(this.events.keys());
    }
}
