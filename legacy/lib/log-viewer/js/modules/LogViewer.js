/**
 * LogViewer - 로그 표시 및 관리 모듈
 */

export default class LogViewer {
    // 메모리 관리 상수
    static MAX_LOGS = 500;  // DOM 표시용 로그 최대 수
    
    // 모드 상수
    static MODE_REALTIME = 'realtime';   // 실시간 모드
    static MODE_FILEMERGE = 'filemerge'; // 파일 병합 모드

    constructor({ eventBus, appState, moduleLoader }) {
        this.eventBus = eventBus;
        this.appState = appState;
        this.moduleLoader = moduleLoader;
        
        // 두 개의 로그 버퍼
        this.domLogs = [];      // DOM에 표시되는 로그들 (500개 제한)
        
        this.maxLogs = Infinity; // 메모리 제약 제거 (나중에 필요 시 제한 추가)
        
        // DOM 요소
        this.logContainer = null;
        this.logTableBody = null;
        this.scrollToBottomBtn = null;
        this.stats = null;
        this.filterStatus = null;

        // 스크롤 디바운싱
        this.scrollRequestTimer = null;
        
        // 표시된 로그 범위 추적 (스크롤 기반 요청용)
        this.displayedLogRange = {
            minIndex: 0,
            maxIndex: 0,
            totalLogs: 0
        };
        
        // 서버 총 로그 수
        this.totalServerLogs = 0;
        
        // 최신 로그 보기 후 스크롤 이벤트 무시 플래그
        this.ignoreScrollEvents = false;
    }

    /**
     * 모듈 초기화
     */
    async init() {
        console.log('[LogViewer] 🚀 모듈 초기화 시작');
        
        try {
            this.initElements();
            this.bindEvents();
            
            // 초기 자동 스크롤 활성화
            this.appState.set('logs.autoScroll', true);
            console.log('[LogViewer] ✅ 초기 자동 스크롤 활성화');
            
            this.updateStats();
            console.log('[LogViewer] ✅ 모듈 초기화 완료');
        } catch (error) {
            console.error('[LogViewer] ❌ 모듈 초기화 실패:', error);
            throw error;
        }
    }

    /**
     * 모듈 정리
     */
    async destroy() {
        console.log('[LogViewer] 🧹 모듈 정리 시작');
        
        // 타이머 정리
        if (this.scrollRequestTimer) {
            clearTimeout(this.scrollRequestTimer);
            this.scrollRequestTimer = null;
        }
        
        this.domLogs = [];
        this.totalServerLogs = 0;
        console.log('[LogViewer] ✅ 모듈 정리 완료');
    }

    /**
     * DOM 요소 초기화
     */
    initElements() {
        console.log('[LogViewer] 🔍 DOM 요소들을 찾는 중...');
        
        this.logContainer = document.getElementById('mainLogContainer');
        console.log('[LogViewer] logContainer:', this.logContainer ? '✅ 찾음' : '❌ 없음');
        
        this.logTableBody = document.getElementById('logTableBody');
        console.log('[LogViewer] logTableBody:', this.logTableBody ? '✅ 찾음' : '❌ 없음');
        
        this.stats = document.getElementById('stats');
        console.log('[LogViewer] stats:', this.stats ? '✅ 찾음' : '❌ 없음');
        
        this.filterStatus = document.getElementById('filter-status');
        console.log('[LogViewer] filterStatus:', this.filterStatus ? '✅ 찾음' : '❌ 없음');
        
        this.scrollToBottomBtn = document.getElementById('scrollToBottomBtn');
        console.log('[LogViewer] scrollToBottomBtn:', this.scrollToBottomBtn ? '✅ 찾음' : '❌ 없음');
        
        if (this.scrollToBottomBtn) {
            console.log('[LogViewer] scrollToBottomBtn 스타일:', window.getComputedStyle(this.scrollToBottomBtn).display);
        }
    }

    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        console.log('[LogViewer] 🔗 이벤트 바인딩 시작');
        
        // 새 로그 수신 - 디버깅 추가
        this.eventBus.subscribe('log:received', (data) => {
            try {
                this.addLogEntry(data);
            } catch (error) {
                console.error('[LogViewer] ❌ log:received 이벤트 처리 중 에러:', error);
            }
        });

        // 배치 로그 수신 처리
        this.eventBus.subscribe('log:batch_received', (data) => {
            try {
                // 서버 총 로그 수 업데이트
                if (typeof data.totalLogs === 'number') {
                    this.totalServerLogs = data.totalLogs;
                }
                
                // 모드 정보 처리 (서버에서 전송한 경우)
                if (data.mode) {
                    console.log('[LogViewer] 🔄 서버 지정 모드 수신:', data.mode);
                    // TODO: 모드에 따른 동작 구현 예정
                }
                
                this.addLogsBatch(data.logs);
            } catch (error) {
                console.error('[LogViewer] ❌ log:batch_received 이벤트 처리 중 에러:', error);
            }
        });

        // 범위 로그 수신 처리 (스크롤 기반 로딩)
        this.eventBus.subscribe('log:range_received', (data) => {
            try {
                // 서버 총 로그 수 업데이트
                if (typeof data.totalLogs === 'number') {
                    this.totalServerLogs = data.totalLogs;
                }
                
                // 범위 로그로 DOM 교체
                this.replaceDomWithRange(data.logs, data.startId, data.endId, data.reason);
                
                // 최신 로그 보기 요청이었다면 자동 스크롤
                if (data.reason === 'scroll_to_bottom') {
                    // 스크롤 이벤트 무시 해제
                    this.ignoreScrollEvents = false;
                    // DOM 업데이트 후 스크롤 실행 (requestAnimationFrame 사용)
                    setTimeout(() => {
                        this.scrollToBottomInternal();
                        this.appState.set('logs.autoScroll', true);
                    }, 100); // 100ms로 줄임 - requestAnimationFrame이 추가 대기시간 제공
                }
            } catch (error) {
                console.error('[LogViewer] ❌ log:range_received 이벤트 처리 중 에러:', error);
            }
        });
        
        // WebSocket 메시지 처리 (총 로그 수 업데이트용)
        this.eventBus.subscribe('websocket:message', (data) => {
            // 서버 응답에서 총 로그 수 추출 및 업데이트
            if (typeof data.totalLogs === 'number') {
                this.totalServerLogs = data.totalLogs;
                // 총 로그 수 표시 즉시 업데이트
                const totalElement = document.getElementById('totalLogs');
                if (totalElement) {
                    totalElement.textContent = this.totalServerLogs;
                }
            }
        });
        
        // WebSocket 연결 상태 디버깅
        this.eventBus.subscribe('websocket:connected', (data) => {
            console.log('[LogViewer] ✅ WebSocket 연결됨:', data);
        });
        
        this.eventBus.subscribe('websocket:disconnected', (data) => {
            console.log('[LogViewer] ❌ WebSocket 연결 끊김:', data);
        });
        
        // 필터 변경
        this.eventBus.subscribe('filter:changed', () => {
            this.applyFilters();
        });
        
        // 로그 타입 관련 이벤트
        this.eventBus.subscribe('log:types-available', (types) => {
            this.setAvailableLogTypes(types);
        });
        
        this.eventBus.subscribe('log:subscription-updated', (response) => {
            // 구독 성공 시 추가 처리 가능
        });
        
        // UI 이벤트
        this.eventBus.subscribe('ui:scroll-to-bottom', () => {
            this.scrollToBottom();
        });
        
        if (this.scrollToBottomBtn) {
            this.scrollToBottomBtn.addEventListener('click', () => {
                this.scrollToBottom();
            });
        } else {
            console.warn('[LogViewer] ⚠️ scrollToBottomBtn이 없어서 클릭 이벤트를 바인딩할 수 없음');
        }
        
        // 키보드 단축키 - Enter, Space로 최신 로그 보기
        document.addEventListener('keydown', (e) => {
            // 스크롤 버튼이 보이는 상태에서만 동작
            if (this.scrollToBottomBtn && this.scrollToBottomBtn.style.display === 'block') {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault(); // 기본 동작 방지
                    this.scrollToBottom();
                }
            }
        });
        
        // 로그 타입 설정 이벤트
        if (this.logTypeSettingsBtn) {
            this.logTypeSettingsBtn.addEventListener('click', () => {
                this.showLogTypeModal();
            });
        }
        
        if (this.applyLogTypesBtn) {
            this.applyLogTypesBtn.addEventListener('click', () => {
                this.applyLogTypeSelection();
            });
        }
        
        if (this.cancelLogTypesBtn) {
            this.cancelLogTypesBtn.addEventListener('click', () => {
                this.hideLogTypeModal();
            });
        }
        
        // 모달 닫기 이벤트
        if (this.logTypeModal) {
            this.logTypeModal.addEventListener('click', (e) => {
                if (e.target === this.logTypeModal) {
                    this.hideLogTypeModal();
                }
            });
            
            const modalClose = this.logTypeModal.querySelector('.modal-close');
            if (modalClose) {
                modalClose.addEventListener('click', () => {
                    this.hideLogTypeModal();
                });
            }
        }
        
        // 스크롤 이벤트 (로그 컨테이너) - 디바운싱 적용
        if (this.logContainer) {
            this.logContainer.addEventListener('scroll', () => {
                this.handleScroll();
            });
        }
    }

    /**
     * 스크롤 이벤트 처리
     */
    handleScroll() {
        // 최신 로그 보기 중에는 스크롤 이벤트 무시
        if (this.ignoreScrollEvents) {
            console.log('[LogViewer] 📜 최신 로그 보기 중 - 스크롤 이벤트 무시');
            return;
        }
        
        if (!this.logContainer) return;
        
        const scrollTop = this.logContainer.scrollTop;
        const scrollHeight = this.logContainer.scrollHeight;
        const clientHeight = this.logContainer.clientHeight;
        const scrollableHeight = scrollHeight - clientHeight;
        
        // 스크롤 비율 계산
        const scrollRatio = scrollableHeight > 0 ? scrollTop / scrollableHeight : 0;
        
        // 사용자 스크롤 감지 및 자동 스크롤 비활성화
        const autoScroll = this.appState.get('logs.autoScroll');
        if (autoScroll && scrollRatio < 0.95) { // 하단 5% 이내가 아니면 사용자 스크롤로 간주
            console.log('[LogViewer] 📜 사용자 스크롤 감지 - 자동 스크롤 비활성화');
            this.appState.set('logs.autoScroll', false);
        }
        
        // 스크롤 위치에 맞는 로그 요청 (가상 스크롤링)
        this.requestLogsForScrollPosition(scrollTop, clientHeight, scrollHeight);
    }

    /**
     * 새 로그 엔트리 추가 (증분 업데이트)
     */
    addLogEntry(logEntry) {
        try {
            if (!logEntry || typeof logEntry !== 'object') {
                console.log('[LogViewer] ⚠️ 로그 엔트리 추가: 유효하지 않은 로그 데이터', logEntry);
                return;
            }

            // 서버 총 로그 수 업데이트
            if (typeof logEntry.totalLogs === 'number') {
                this.totalServerLogs = logEntry.totalLogs;
            }

            const autoScroll = this.appState.get('logs.autoScroll');

            // 스크롤 모드에서는 실시간 로그 무시 (사용자가 보고 있는 로그 범위 유지)
            if (!autoScroll) {
                return;
            }

            // 자동 스크롤 모드일 때만 DOM 로그 버퍼에 추가 (LRU 적용)
            if (this.domLogs.length >= LogViewer.MAX_LOGS) {
                const removed = this.domLogs.shift();
            }
            this.domLogs.push(logEntry);

            // 3. 표시된 로그 범위 업데이트
            this.updateDisplayedLogRange();

            // 4. 총 로그 수 즉시 업데이트
            const totalElement = document.getElementById('totalLogs');
            if (totalElement) {
                totalElement.textContent = this.totalServerLogs > 0 ? this.totalServerLogs : this.domLogs.length;
            }

            // 5. 증분 DOM 업데이트: 새 로그만 처리
            this.addSingleLogToTable(logEntry);

            // 6. 자동 스크롤
            const isButtonVisible = this.scrollToBottomBtn && this.scrollToBottomBtn.style.display === 'block';

            if (autoScroll && !isButtonVisible) {
                this.scrollToBottomInternal();
            }

            // 7. 통계 업데이트 (100개마다만)
            if (this.domLogs.length % 100 === 0) {
                this.updateStats();
            }
        } catch (error) {
            console.error('[LogViewer] ❌ 로그 엔트리 추가 중 에러:', error, { logEntry: logEntry });
            throw error;
        }
    }

    /**
     * 단일 로그를 테이블에 추가 (성능 최적화)
     */
    addSingleLogToTable(log) {
        if (!this.logTableBody) return;
        
        // 필터 체크
        const activeFilters = this.appState.get('filters.active') || [];
        if (activeFilters.length > 0) {
            const passesFilter = activeFilters.every(filter => this.matchesFilter(log, filter));
            if (!passesFilter) {
                return; // 필터에 맞지 않으면 추가하지 않음
            }
        }
        
        // 새 행 생성 및 추가
        const row = this.createLogRow(log);
        this.logTableBody.appendChild(row);
    }

    /**
     * 배치 로그 추가 (고성능)
     */
    addLogsBatch(logs) {
        try {
            if (!logs || !Array.isArray(logs) || logs.length === 0) {
                console.log('[LogViewer] ⚠️ 배치 로그 추가: 유효하지 않은 로그 데이터', logs);
                return;
            }

            // 버퍼 초기화 확인
            if (!Array.isArray(this.domLogs)) {
                console.error('[LogViewer] ❌ domLogs가 배열이 아님:', this.domLogs);
                this.domLogs = [];
            }

            const autoScroll = this.appState?.get ? this.appState.get('logs.autoScroll') : true;

            // 스크롤 모드에서는 실시간 로그 무시 (사용자가 보고 있는 로그 범위 유지)
            if (!autoScroll) {
                return;
            }

            // 2. 자동 스크롤 모드일 때만 DOM 로그 버퍼에 제한 적용해서 추가
            const domAvailableSpace = LogViewer.MAX_LOGS - this.domLogs.length;

            let logsForDom = logs;
            let shouldUpdateTableFull = false;

            if (logs.length > domAvailableSpace && domAvailableSpace > 0) {
                logsForDom = logs.slice(0, domAvailableSpace);
            } else if (domAvailableSpace <= 0) {
                // 공간이 없어도 자동 스크롤 중이면 최신 로그로 교체
                if (autoScroll) {
                    logsForDom = logs.slice(-LogViewer.MAX_LOGS); // 최신 로그로 교체
                    this.domLogs = [...logsForDom];
                    shouldUpdateTableFull = true; // 테이블 완전 재구성 필요
                } else {
                    logsForDom = [];
                }
            } else {
                this.domLogs.push(...logsForDom);
            }

            // 3. 표시된 로그 범위 업데이트
            this.updateDisplayedLogRange();

            // 4. 총 로그 수 즉시 업데이트
            const totalElement = document.getElementById('totalLogs');
            if (totalElement) {
                totalElement.textContent = this.totalServerLogs > 0 ? this.totalServerLogs : this.domLogs.length;
            }

            // 5. DOM 배치 업데이트
            if (shouldUpdateTableFull) {
                // DOM 버퍼 완전 교체 시 테이블 재구성
                this.updateTableFull();
            } else if (logsForDom && logsForDom.length > 0) {
                // 일반적인 경우 배치 추가
                this.addLogsBatchToTable(logsForDom);
            }

            // 6. 자동 스크롤
            const isButtonVisible = this.scrollToBottomBtn && this.scrollToBottomBtn.style.display === 'block';

            if (autoScroll && !isButtonVisible) {
                this.scrollToBottomInternal();
            }

            // 7. 통계 업데이트
            this.updateStats();
        } catch (error) {
            console.error('[LogViewer] ❌ 배치 로그 추가 중 에러:', error, error?.stack);
            throw error;
        }
    }

    /**
     * 배치 로그를 테이블에 추가 (DocumentFragment 사용)
     */
    addLogsBatchToTable(logs) {
        if (!this.logTableBody || !logs || logs.length === 0) return;
        
        const activeFilters = this.appState.get('filters.active') || [];
        const fragment = document.createDocumentFragment();
        
        logs.forEach(log => {
            // 필터 체크
            if (activeFilters.length > 0) {
                const passesFilter = activeFilters.every(filter => this.matchesFilter(log, filter));
                if (!passesFilter) {
                    return;
                }
            }
            
            const row = this.createLogRow(log);
            fragment.appendChild(row);
        });
        
        // 한 번에 DOM 추가
        this.logTableBody.appendChild(fragment);
    }

    /**
     * 필터 적용 (전체 재구성 최적화)
     */
    applyFilters() {
        if (!this.logTableBody) return;
        
        // 필터 변경 시에만 전체 테이블 재구성
        this.updateTableFull();
        
        // 자동 스크롤 (필터 적용 후) - 버튼이 표시되지 않은 상태에서만 실행
        const autoScroll = this.appState.get('logs.autoScroll');
        const isButtonVisible = this.scrollToBottomBtn && this.scrollToBottomBtn.style.display === 'block';
        
        if (autoScroll && !isButtonVisible) {
            // 지연 제거 - 즉시 스크롤 실행
            this.scrollToBottomInternal();
        }
        
        // 통계 업데이트
        this.updateStats();
    }

    /**
     * 전체 테이블 업데이트 (필터 변경 시에만 사용)
     */
    updateTableFull() {
        if (!this.logTableBody) return;
        
        // 실시간 필터링 적용
        const activeFilters = this.appState.get('filters.active') || [];
        let logsToDisplay = this.domLogs;
        
        if (activeFilters.length > 0) {
            logsToDisplay = this.domLogs.filter(log => {
                return activeFilters.every(filter => this.matchesFilter(log, filter));
            });
        }
        
        // 성능 최적화: DocumentFragment 사용
        const fragment = document.createDocumentFragment();
        
        // 필터링된 로그들 표시 (배치 처리)
        logsToDisplay.forEach(log => {
            const row = this.createLogRow(log);
            fragment.appendChild(row);
        });
        
        // 한 번에 DOM 업데이트
        this.logTableBody.innerHTML = '';
        this.logTableBody.appendChild(fragment);
    }

    /**
     * 로그가 필터와 일치하는지 확인
     */
    matchesFilter(log, filter) {
        if (filter.type === 'level') {
            return log.level === filter.value;
        } else if (filter.type === 'pid') {
            // PID 비교 시 타입 변환 (문자열/숫자 호환)
            return parseInt(log.pid, 10) === parseInt(filter.value, 10);
        } else if (filter.type === 'tag') {
            return log.tag === filter.value;
        } else if (filter.type === 'message') {
            return log.message.toLowerCase().includes(filter.value.toLowerCase());
        }
        return false;
    }

    /**
     * 테이블 업데이트
     */
    updateTable() {
        console.warn('[LogViewer] updateTable() 호출됨 - 성능 문제로 사용 금지');
        this.updateTableFull();
    }

    /**
     * 로그 행 생성
     */
    createLogRow(log) {
        const row = document.createElement('tr');
        row.className = `log-level-${log.level.toLowerCase()}`;
        row.dataset.logId = log.id; // 북마크 관리를 위한 ID 추가
        
        // 원본 시간 문자열이 있으면 그대로 사용, 없으면 파싱된 timestamp 사용
        const time = log.timeStr || new Date(log.timestamp).toLocaleString('ko-KR', {
            month: 'short',
            day: '2-digit',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).replace(/\./g, '').replace(/년|월/g, ' ').replace(/일/, '');
        
        row.innerHTML = `
            <td class="bookmark-cell" title="북마크 토글 (더블클릭)">☆</td>
            <td class="index-cell">${log.index}</td>
            <td class="timestamp-cell">${time}</td>
            <td class="level-cell level-${log.level.toLowerCase()}" style="display: none;">${log.level}</td>
            <td class="source-cell">${log.source || '-'}</td>
            <td class="tag-cell">${log.tag || '-'}</td>
            <td class="pid-cell">${log.pid || '-'}</td>
            <td class="message-cell" title="${this.escapeHtml(log.message)}">${this.escapeHtml(log.message)}</td>
        `;
        
        return row;
    }

    /**
     * HTML 이스케이프
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * 통계 업데이트
     */
    updateStats() {
        if (!this.stats) return;
        
        // 서버 총 로그 수를 우선 사용, 없으면 DOM 로그 수 사용
        const totalLogs = this.totalServerLogs > 0 ? this.totalServerLogs : this.domLogs.length;
        
        console.log('[LogViewer] 📊 updateStats: totalServerLogs=', this.totalServerLogs, 'domLogs.length=', this.domLogs.length, 'totalLogs=', totalLogs);
        
        // 실시간 필터링된 로그 수 계산
        const activeFilters = this.appState.get('filters.active') || [];
        let filteredCount = totalLogs;
        if (activeFilters.length > 0) {
            filteredCount = this.domLogs.filter(log => {
                return activeFilters.every(filter => this.matchesFilter(log, filter));
            }).length;
        }
        
        let statsText = `총 ${totalLogs}개 로그`;
        
        if (activeFilters.length > 0) {
            statsText += ` (필터 적용: ${filteredCount}개 표시)`;
        } else {
            statsText += ` (${filteredCount}개 표시)`;
        }
        
        // 레벨별 통계 (필터링된 로그 기준)
        const levelCounts = {};
        const logsToCount = activeFilters.length > 0 ? 
            this.domLogs.filter(log => activeFilters.every(filter => this.matchesFilter(log, filter))) : 
            this.domLogs;
        
        logsToCount.forEach(log => {
            levelCounts[log.level] = (levelCounts[log.level] || 0) + 1;
        });
        
        const levelStats = Object.entries(levelCounts)
            .map(([level, count]) => `${level}: ${count}`)
            .join(', ');
        
        if (levelStats) {
            statsText += ` | ${levelStats}`;
        }
        
        this.stats.textContent = statsText;
    }

    /**
     * 하단으로 스크롤 (사용자 명시적 액션용) - 최신 로그 보기 기능 포함
     */
    scrollToBottom() {
        console.log('[LogViewer] 🖱️ 사용자 명시적 스크롤 요청');
        
        // 먼저 자동 스크롤 모드 활성화 (스크롤 이벤트 방지)
        this.appState.set('logs.autoScroll', true);
        
        // 일시적으로 스크롤 이벤트 무시 (최신 로그 로딩 중)
        this.ignoreScrollEvents = true;
        setTimeout(() => {
            this.ignoreScrollEvents = false;
        }, 1000); // 1초 동안 스크롤 이벤트 무시
        
        // 서버에서 최신 로그 요청 (항상)
        if (this.totalServerLogs > 0) {
            console.log('[LogViewer] 📡 서버에서 최신 로그 요청');
            // 서버에서 최신 로그 범위 요청 (마지막 500개)
            const startIndex = Math.max(0, this.totalServerLogs - LogViewer.MAX_LOGS);
            const endIndex = this.totalServerLogs - 1;
            
            this.eventBus.publish('websocket:send', {
                type: 'range_request',
                min_index: startIndex,
                max_index: endIndex,
                reason: 'scroll_to_bottom'  // 최신 로그 보기임을 표시
            });
            
            // 서버 응답을 기다리므로 여기서는 스크롤하지 않음
            // log:range_received 이벤트 핸들러에서 DOM 업데이트 후 스크롤 실행
        } else {
            // 서버 로그가 없으면 그냥 스크롤
            this.scrollToBottomInternal();
            // 사용자가 직접 버튼을 클릭한 경우이므로 자동 스크롤 활성화
            this.appState.set('logs.autoScroll', true);
        }
    }

    /**
     * 실제 스크롤 동작 (내부용)
     */
    scrollToBottomInternal() {
        if (!this.logContainer) {
            console.error('[LogViewer] ❌ 스크롤 컨테이너가 없음');
            return;
        }
        
        // DOM 업데이트가 완료될 때까지 기다렸다가 스크롤 실행
        requestAnimationFrame(() => {
            const scrollHeight = this.logContainer.scrollHeight;
            const currentScrollTop = this.logContainer.scrollTop;
            
            // 컨테이너를 맨 아래로 스크롤
            this.logContainer.scrollTop = scrollHeight;
            
            // 스크롤이 제대로 적용되었는지 확인
            requestAnimationFrame(() => {
                const newScrollTop = this.logContainer.scrollTop;
                if (newScrollTop !== scrollHeight) {
                    // 재시도
                    setTimeout(() => {
                        this.logContainer.scrollTop = this.logContainer.scrollHeight;
                    }, 100);
                }
            });
        });
    }

    /**
     * 범위 로그로 DOM 교체 (스크롤 기반 로딩)
     */
    replaceDomWithRange(logs, startId, endId, reason) {
        try {
            if (!logs || logs.length === 0) {
                console.log('[LogViewer] ⚠️ 교체할 로그가 없음');
                return;
            }
            
            // DOM 로그 버퍼 교체
            this.domLogs = [...logs];
            
            // 표시 범위 업데이트
            this.updateDisplayedLogRange();
            
            // 테이블 완전 재구성
            this.updateTableFull();
            
            // 최신 로그 보기인 경우 자동 스크롤은 이벤트 핸들러에서 처리하므로 여기서는 생략
        } catch (error) {
            console.error('[LogViewer] ❌ DOM 범위 교체 중 에러:', error);
        }
    }





    /**
     * 로그 타입 모달 표시
     */
    showLogTypeModal() {
        console.log('[LogViewer] 📋 로그 타입 모달 표시 시도');
        console.log('[LogViewer] 📋 availableLogTypes:', this.availableLogTypes);
        console.log('[LogViewer] 📋 logTypeModal:', this.logTypeModal);
        console.log('[LogViewer] 📋 logTypeOptions:', this.logTypeOptions);
        
        if (!this.logTypeModal || !this.logTypeOptions) {
            console.error('[LogViewer] ❌ 모달 요소가 없음');
            return;
        }
        
        // 모달에 옵션 채우기
        this.populateLogTypeOptions();
        
        // 모달 표시
        this.logTypeModal.style.display = 'block';
        console.log('[LogViewer] ✅ 로그 타입 모달 표시됨');
    }

    /**
     * 로그 타입 모달 숨기기
     */
    hideLogTypeModal() {
        if (!this.logTypeModal) return;
        this.logTypeModal.style.display = 'none';
    }

    /**
     * 로그 타입 옵션 채우기
     */
    populateLogTypeOptions() {
        if (!this.logTypeOptions) return;
        
        this.logTypeOptions.innerHTML = '';
        
        this.availableLogTypes.forEach(type => {
            const optionDiv = document.createElement('div');
            optionDiv.className = `log-type-option ${type.available ? '' : 'disabled'}`;
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `log-type-${type.name}`;
            checkbox.checked = this.selectedLogTypes.includes(type.name);
            if (!type.available) {
                checkbox.disabled = true;
            }
            
            const label = document.createElement('label');
            label.htmlFor = `log-type-${type.name}`;
            label.textContent = type.name;
            
            const status = document.createElement('span');
            status.className = 'log-type-status';
            status.textContent = type.configured ? '(설정됨)' : '(미설정)';
            
            optionDiv.appendChild(checkbox);
            optionDiv.appendChild(label);
            optionDiv.appendChild(status);
            
            this.logTypeOptions.appendChild(optionDiv);
        });
    }

    /**
     * 로그 타입 선택 적용
     */
    applyLogTypeSelection() {
        if (!this.logTypeOptions) return;
        
        const checkboxes = this.logTypeOptions.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)');
        const selectedTypes = Array.from(checkboxes).map(cb => cb.id.replace('log-type-', ''));
        
        this.selectedLogTypes = selectedTypes;
        
        // WebSocket으로 구독 메시지 전송
        this.eventBus.publish('websocket:send', {
            type: 'subscribe',
            logTypes: selectedTypes
        });
        
        this.hideLogTypeModal();
        
        console.log('[LogViewer] 로그 타입 구독 적용:', selectedTypes);
    }

    /**
     * 스크롤 이벤트 처리
     */
    handleScroll() {
        if (!this.logContainer) return;
        
        const scrollTop = this.logContainer.scrollTop;
        const scrollHeight = this.logContainer.scrollHeight;
        const clientHeight = this.logContainer.clientHeight;
        
        // 스크롤 가능한 높이 계산 (0으로 나누기 방지)
        const scrollableHeight = scrollHeight - clientHeight;
        const scrollRatio = scrollableHeight > 0 ? scrollTop / scrollableHeight : 0;
        
        // 스크롤 방향 감지
        const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10; // 10px 오차 허용
        
        // 자동 스크롤 상태 업데이트
        const currentAutoScroll = this.appState.get('logs.autoScroll');
        
        if (isAtBottom && !currentAutoScroll) {
            this.appState.set('logs.autoScroll', true);
            this.eventBus.publish('app:state-changed', { key: 'logs.autoScroll', value: true });
        } else if (!isAtBottom && currentAutoScroll) {
            this.appState.set('logs.autoScroll', false);
            this.eventBus.publish('app:state-changed', { key: 'logs.autoScroll', value: false });
        }
        
        // 스크롤 위치에 따른 로그 요청 (뷰포트 기반)
        // 자동 스크롤 중에는 서버 요청 생략 (로그가 자동으로 쌓이므로)
        if (!currentAutoScroll) {
            // 로그 요청
            this.requestLogsForScrollPosition(scrollTop, clientHeight, scrollHeight);
        }
        
        // 스크롤 버튼 표시/숨김
        this.updateScrollButtonVisibility();
    }

    /**
     * 스크롤 버튼 표시 상태 업데이트
     */
    updateScrollButtonVisibility() {
        if (!this.scrollToBottomBtn || !this.logContainer) return;
        
        const scrollTop = this.logContainer.scrollTop;
        const scrollHeight = this.logContainer.scrollHeight;
        const clientHeight = this.logContainer.clientHeight;
        
        // 하단에서 100px 이상 떨어져 있으면 버튼 표시
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        const shouldShow = distanceFromBottom > 100;
        
        // 현재 자동 스크롤 상태 확인
        const currentAutoScroll = this.appState.get('logs.autoScroll');
        
        if (shouldShow && this.scrollToBottomBtn.style.display !== 'block') {
            this.scrollToBottomBtn.style.display = 'block';
            // 자동 스크롤이 활성화된 상태에서만 비활성화
            if (currentAutoScroll) {
                this.appState.set('logs.autoScroll', false);
            }
        } else if (!shouldShow && this.scrollToBottomBtn.style.display === 'block') {
            this.scrollToBottomBtn.style.display = 'none';
            // 자동 스크롤이 비활성화된 상태에서만 활성화
            if (!currentAutoScroll) {
                this.appState.set('logs.autoScroll', true);
            }
        }
    }

    /**
     * 표시된 로그 범위 업데이트
     */
    updateDisplayedLogRange() {
        if (this.domLogs.length === 0) {
            this.displayedLogRange = { minIndex: 0, maxIndex: 0, totalLogs: 0 };
            return;
        }
        
        // 현재 DOM에 있는 로그들의 인덱스 범위 계산
        const indices = this.domLogs.map(log => log.index);
        const minIndex = Math.min(...indices);
        const maxIndex = Math.max(...indices);
        
        this.displayedLogRange = {
            minIndex: minIndex,
            maxIndex: maxIndex,
            totalLogs: this.domLogs.length
        };
    }

    /**
     * 스크롤 위치에 맞는 로그 요청 (표시된 범위 기반)
     */
    requestLogsForScrollPosition(scrollTop, clientHeight, scrollHeight) {
        if (this.totalServerLogs === 0) {
            return;
        }
        
        // 스크롤 가능한 높이 계산 (0으로 나누기 방지)
        const scrollableHeight = scrollHeight - clientHeight;
        if (scrollableHeight <= 0) {
            return;
        }
        
        // 스크롤 위치에 따른 요청 범위 계산 (전체 서버 로그 기준)
        const scrollRatio = scrollTop / scrollableHeight;
        const totalServerLogs = this.totalServerLogs;
        const logsPerPage = LogViewer.MAX_LOGS; // 한 페이지에 표시할 로그 수
        
        // 스크롤 비율에 따라 시작 인덱스 계산
        let startIndex = Math.floor(scrollRatio * (totalServerLogs - logsPerPage));
        let endIndex = Math.min(startIndex + logsPerPage - 1, totalServerLogs - 1);
        
        // 스크롤이 가장 아래에 가까우면 (scrollRatio >= 0.99) 마지막 로그를 포함하도록 조정
        if (scrollRatio >= 0.99) {
            startIndex = Math.max(0, totalServerLogs - logsPerPage);
            endIndex = totalServerLogs - 1;
        }
        
        // 스크롤이 가장 위에 가까우면 (scrollRatio <= 0.01) 첫 로그를 포함하도록 조정
        if (scrollRatio <= 0.01) {
            startIndex = 0;
            endIndex = Math.min(logsPerPage - 1, totalServerLogs - 1);
        }
            
        // 현재 표시된 범위와 비교해서 요청할지 결정
        const currentMin = this.displayedLogRange.minIndex;
        const currentMax = this.displayedLogRange.maxIndex;
        
        // 스크롤이 시작이나 끝에 가까우면 무조건 요청 (차이 검사 생략)
        const isNearStart = scrollRatio <= 0.01;
        const isNearEnd = scrollRatio >= 0.99;

        if (!isNearStart && !isNearEnd) {
            const rangeDiff = Math.abs(startIndex - currentMin);
            if (rangeDiff <= logsPerPage * 0.3) {
            console.log(`[LogViewer] 범위 차이가 작음 (${rangeDiff}) - 요청 생략`);
            return;
            }
        }
        
        // 서버에 범위 기반 로그 요청
        this.eventBus.publish('websocket:send', {
            type: 'range_request',
            min_index: startIndex,
            max_index: endIndex,
            current_min: currentMin,
            current_max: currentMax
        });
    }
}
