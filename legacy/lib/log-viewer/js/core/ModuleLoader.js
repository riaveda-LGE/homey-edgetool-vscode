/**
 * ModuleLoader - 동적 모듈 로딩 시스템
 * 
 * 모듈간 의존성 관리, 동적 로딩, 생명주기 관리
 * 확장 가능한 모듈러 아키텍처의 핵심
 */

export default class ModuleLoader {
    constructor(eventBus, appState) {
        this.eventBus = eventBus;
        this.appState = appState;
        this.modules = new Map();
        this.moduleConfigs = new Map();
        this.debug = false;
        
        this.registerCoreModules();
    }

    /**
     * 디버그 모드 설정
     */
    setDebug(enabled) {
        this.debug = enabled;
        if (enabled) {
            console.log('[ModuleLoader] 디버그 모드 활성화');
        }
    }

    /**
     * 핵심 모듈 설정 등록
     */
    registerCoreModules() {
        // LogViewer 모듈
        this.registerModuleConfig('LogViewer', {
            path: '/js/modules/LogViewer.js',
            dependencies: ['WebSocketService'],
            singleton: true,
            autoLoad: false
        });

        // WebSocketService 모듈
        this.registerModuleConfig('WebSocketService', {
            path: '/js/modules/WebSocketService.js',
            dependencies: [],
            singleton: true,
            autoLoad: false
        });

        // FilterManager 모듈
        this.registerModuleConfig('FilterManager', {
            path: '/js/modules/FilterManager.js',
            dependencies: [],
            singleton: true,
            autoLoad: false
        });

        // SearchManager 모듈
        this.registerModuleConfig('SearchManager', {
            path: '/js/modules/SearchManager.js',
            dependencies: ['LogViewer'],
            singleton: true,
            autoLoad: false
        });

        // BookmarkManager 모듈
        this.registerModuleConfig('BookmarkManager', {
            path: '/js/modules/BookmarkManager.js',
            dependencies: ['LogViewer'],
            singleton: true,
            autoLoad: false
        });

        // HighlightManager 모듈
        this.registerModuleConfig('HighlightManager', {
            path: '/js/modules/HighlightManager.js',
            dependencies: [],
            singleton: true,
            autoLoad: false
        });

        // TooltipManager 모듈
        this.registerModuleConfig('TooltipManager', {
            path: '/js/modules/TooltipManager.js',
            dependencies: [],
            singleton: true,
            autoLoad: false
        });

        // DebugLogger 유틸리티
        this.registerModuleConfig('DebugLogger', {
            path: '/js/utils/DebugLogger.js',
            dependencies: [],
            singleton: true,
            autoLoad: true,
            isUtility: true
        });
    }

    /**
     * 모듈 설정 등록
     */
    registerModuleConfig(moduleName, config) {
        this.moduleConfigs.set(moduleName, {
            path: config.path,
            dependencies: config.dependencies || [],
            singleton: config.singleton || false,
            autoLoad: config.autoLoad || false,
            loaded: false,
            loading: false,
            instance: null
        });

        if (this.debug) {
            console.log(`[ModuleLoader] 모듈 설정 등록: ${moduleName}`, config);
        }
    }

    /**
     * 모듈 로드
     */
    async loadModule(moduleName) {
        console.log(`[ModuleLoader] 🔄 모듈 로딩 시작: ${moduleName}`);
        
        if (!this.moduleConfigs.has(moduleName)) {
            console.error(`[ModuleLoader] ❌ 모듈 설정을 찾을 수 없습니다: ${moduleName}`);
            throw new Error(`모듈 설정을 찾을 수 없습니다: ${moduleName}`);
        }

        const config = this.moduleConfigs.get(moduleName);

        // 이미 로드된 싱글톤 반환
        if (config.singleton && config.loaded && config.instance) {
            return config.instance;
        }

        // 로딩 중인 경우 대기
        if (config.loading) {
            return new Promise((resolve) => {
                const checkLoaded = () => {
                    if (config.loaded) {
                        resolve(config.instance);
                    } else {
                        setTimeout(checkLoaded, 10);
                    }
                };
                checkLoaded();
            });
        }

        config.loading = true;

        try {
            // 의존성 먼저 로드
            await this.loadDependencies(config.dependencies);

            // 모듈 임포트
            const moduleExports = await import(config.path);
            const ModuleClass = moduleExports.default || moduleExports[moduleName];

            if (!ModuleClass) {
                console.error(`[ModuleLoader] ❌ 모듈 클래스를 찾을 수 없습니다: ${moduleName}`);
                throw new Error(`모듈 클래스를 찾을 수 없습니다: ${moduleName}`);
            }

            // 인스턴스 생성
            const instanceParams = {
                eventBus: this.eventBus,
                appState: this.appState,
                moduleLoader: this
            };

            // DebugLogger 유틸리티인 경우 특별 처리
            if (config.isUtility && moduleName === 'DebugLogger') {
                const instance = new ModuleClass();
                config.instance = instance;
                config.loaded = true;
                config.loading = false;
                this.modules.set(moduleName, instance);
                console.log(`[ModuleLoader] ✅ 유틸리티 로딩 완료: ${moduleName}`);
                return instance;
            }

            const instance = new ModuleClass(instanceParams);

            // DebugLogger 자동 설정 (유틸리티가 아닌 일반 모듈들에게)
            if (!config.isUtility) {
                await this.setupDebugLogger(instance, moduleName);
            }

            // 모듈 초기화
            if (typeof instance.init === 'function') {
                await instance.init();
            }

            config.instance = instance;
            config.loaded = true;
            config.loading = false;

            this.modules.set(moduleName, instance);

            console.log(`[ModuleLoader] ✅ 모듈 로딩 완료: ${moduleName}`);

            // 로딩 완료 이벤트 발행
            this.eventBus.publish('module:loaded', { moduleName, instance });

            return instance;

        } catch (error) {
            config.loading = false;
            console.error(`[ModuleLoader] ❌ 모듈 로딩 실패: ${moduleName}`, error);
            this.eventBus.publish('module:load-error', { moduleName, error });
            throw error;
        }
    }

    /**
     * 의존성 로드
     */
    async loadDependencies(dependencies) {
        if (!dependencies.length) return;

        if (this.debug) {
            console.log('[ModuleLoader] 의존성 로딩:', dependencies);
        }

        const loadPromises = dependencies.map(dep => this.loadModule(dep));
        await Promise.all(loadPromises);
    }

    /**
     * 모듈 언로드
     */
    async unloadModule(moduleName) {
        const config = this.moduleConfigs.get(moduleName);
        if (!config || !config.loaded) return;

        const instance = config.instance;

        // 모듈 정리
        if (typeof instance.destroy === 'function') {
            await instance.destroy();
        }

        config.loaded = false;
        config.instance = null;
        this.modules.delete(moduleName);

        if (this.debug) {
            console.log(`[ModuleLoader] 모듈 언로드: ${moduleName}`);
        }

        this.eventBus.publish('module:unloaded', { moduleName });
    }

    /**
     * 모든 모듈 언로드
     */
    async unloadAll() {
        const moduleNames = Array.from(this.modules.keys());
        
        for (const moduleName of moduleNames) {
            await this.unloadModule(moduleName);
        }

        if (this.debug) {
            console.log('[ModuleLoader] 모든 모듈 언로드 완료');
        }
    }

    /**
     * 로드된 모듈 가져오기
     */
    getModule(moduleName) {
        return this.modules.get(moduleName);
    }

    /**
     * 모듈에 DebugLogger 설정
     */
    async setupDebugLogger(instance, moduleName) {
        try {
            // DebugLogger 자체인 경우 설정하지 않음 (순환 참조 방지)
            if (moduleName === 'DebugLogger') {
                return;
            }
            
            // DebugLogger가 이미 로드되었는지 확인
            if (!this.modules.has('DebugLogger')) {
                console.warn(`[ModuleLoader] DebugLogger가 아직 로드되지 않음 for ${moduleName}`);
                return;
            }
            
            const debugLogger = this.modules.get('DebugLogger');
            
            if (debugLogger && typeof debugLogger.setModulePrefix === 'function') {
                // 모듈별 prefix 설정
                const moduleDebugLogger = Object.create(debugLogger);
                moduleDebugLogger.setModulePrefix(moduleName);
                
                // WebSocketService 연결 (있으면)
                if (this.modules.has('WebSocketService')) {
                    const webSocketService = this.modules.get('WebSocketService');
                    moduleDebugLogger.setWebSocketService(webSocketService);
                }
                
                // 인스턴스에 debugLog 메서드 추가
                instance.debugLog = (level, message, ...args) => {
                    moduleDebugLogger.log(level, message, ...args);
                };
                
                // 편의 메서드들도 추가
                instance.debug = (message, ...args) => moduleDebugLogger.debug(message, ...args);
                instance.info = (message, ...args) => moduleDebugLogger.info(message, ...args);
                instance.warn = (message, ...args) => moduleDebugLogger.warn(message, ...args);
                instance.error = (message, ...args) => moduleDebugLogger.error(message, ...args);
            }
        } catch (error) {
            console.warn(`[ModuleLoader] DebugLogger 설정 실패 for ${moduleName}:`, error);
        }
    }

    /**
     * 모듈 존재 여부 확인
     */
    hasModule(moduleName) {
        return this.modules.has(moduleName);
    }

    /**
     * 로드된 모듈 목록
     */
    getLoadedModules() {
        return Array.from(this.modules.keys());
    }

    /**
     * 모듈 상태 정보
     */
    getModuleStatus() {
        const status = {};
        
        for (const [name, config] of this.moduleConfigs) {
            status[name] = {
                loaded: config.loaded,
                loading: config.loading,
                singleton: config.singleton,
                dependencies: config.dependencies
            };
        }
        
        return status;
    }
}
