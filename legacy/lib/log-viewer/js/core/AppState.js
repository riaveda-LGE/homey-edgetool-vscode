/**
 * AppState - 전역 상태 관리
 * 
 * 애플리케이션의 모든 상태를 중앙집중식으로 관리
 * localStorage 동기화, 상태 변경 감지, 유효성 검사 포함
 */

export default class AppState {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.state = this.getDefaultState();
        this.watchers = new Map();
        this.debug = false;
        
        this.loadFromStorage();
    }

    /**
     * 기본 상태 정의
     */
    getDefaultState() {
        return {
            ui: {
                theme: 'dark',
                fontSize: 14
            },
            logs: {
                maxLines: 10000,
                isStreaming: false,
                filterText: '',
                autoScroll: true
            },
            filters: {
                active: [],
                history: []
            },
            connection: {
                status: 'disconnected',
                lastConnected: null
            }
        };
    }

    /**
     * 디버그 모드 설정
     */
    setDebug(enabled) {
        this.debug = enabled;
        if (enabled) {
            console.log('[AppState] 디버그 모드 활성화');
        }
    }

    /**
     * 상태 값 가져오기
     */
    get(path) {
        const keys = path.split('.');
        let current = this.state;
        
        for (const key of keys) {
            if (current && typeof current === 'object' && key in current) {
                current = current[key];
            } else {
                return undefined;
            }
        }
        
        return current;
    }

    /**
     * 상태 값 설정
     */
    set(path, value) {
        const keys = path.split('.');
        const lastKey = keys.pop();
        let current = this.state;
        
        // 중첩 객체 생성
        for (const key of keys) {
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        
        const oldValue = current[lastKey];
        current[lastKey] = value;
        
        // 변경 이벤트 발행
        this.eventBus.publish('state:changed', { path, oldValue, newValue: value });
        
        // 와처 실행
        this.executeWatchers(path, value, oldValue);
        
        // localStorage 저장
        this.saveToStorage();
    }

    /**
     * 상태 변경 감지 (watcher 등록)
     */
    watch(path, callback) {
        if (!this.watchers.has(path)) {
            this.watchers.set(path, new Set());
        }
        
        this.watchers.get(path).add(callback);
        
        if (this.debug) {
            console.log(`[AppState] 와처 등록: ${path}`);
        }
        
        // 와처 해제 함수 반환
        return () => this.unwatch(path, callback);
    }

    /**
     * 와처 해제
     */
    unwatch(path, callback) {
        if (this.watchers.has(path)) {
            this.watchers.get(path).delete(callback);
            
            if (this.watchers.get(path).size === 0) {
                this.watchers.delete(path);
            }
        }
    }

    /**
     * 와처 실행
     */
    executeWatchers(path, newValue, oldValue) {
        // 정확한 경로 와처
        if (this.watchers.has(path)) {
            this.watchers.get(path).forEach(callback => {
                try {
                    callback(newValue, oldValue, path);
                } catch (error) {
                    console.error(`[AppState] 와처 실행 오류 (${path}):`, error);
                    this.eventBus.publish('system:error', { path, error });
                }
            });
        }
        
        // 부모 경로 와처들도 실행
        const pathParts = path.split('.');
        for (let i = pathParts.length - 1; i > 0; i--) {
            const parentPath = pathParts.slice(0, i).join('.');
            if (this.watchers.has(parentPath)) {
                this.watchers.get(parentPath).forEach(callback => {
                    try {
                        callback(this.get(parentPath), undefined, parentPath);
                    } catch (error) {
                        console.error(`[AppState] 부모 와처 실행 오류 (${parentPath}):`, error);
                    }
                });
            }
        }
    }

    /**
     * localStorage에서 상태 로드
     */
    loadFromStorage() {
        try {
            const stored = localStorage.getItem('edgetool-state');
            if (stored) {
                const parsedState = JSON.parse(stored);
                this.state = { ...this.getDefaultState(), ...parsedState };
                
                if (this.debug) {
                    console.log('[AppState] localStorage에서 상태 로드 완료');
                }
            }
        } catch (error) {
            console.error('[AppState] localStorage 로드 실패:', error);
            this.state = this.getDefaultState();
        }
    }

    /**
     * localStorage에 상태 저장
     */
    saveToStorage() {
        try {
            localStorage.setItem('edgetool-state', JSON.stringify(this.state));
            
            // 너무 빈번한 저장 로그 제거
            // if (this.debug) {
            //     console.log('[AppState] localStorage에 상태 저장 완료');
            // }
        } catch (error) {
            console.error('[AppState] localStorage 저장 실패:', error);
        }
    }

    /**
     * 상태 초기화
     */
    reset(saveToStorage = true) {
        this.state = this.getDefaultState();
        
        if (saveToStorage) {
            this.saveToStorage();
        }
        
        this.eventBus.publish('state:reset', {});
        
        if (this.debug) {
            console.log('[AppState] 상태 초기화 완료');
        }
    }

    /**
     * 전체 상태 반환 (읽기 전용)
     */
    getState() {
        return JSON.parse(JSON.stringify(this.state));
    }
}
