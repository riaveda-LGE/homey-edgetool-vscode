/**
 * FilterManager 모듈
 * 
 * 필터 관리, UI 이벤트 처리, 필터 기록 관리
 * 필터 관련 모든 로직을 담당
 */

export default class FilterManager {
    constructor({ eventBus, appState }) {
        this.eventBus = eventBus;
        this.appState = appState;
        
        // DOM 요소
        this.filterInput = null;
        this.addFilterBtn = null;
        this.clearFiltersBtn = null;
        this.filterTags = null;
    }

    /**
     * 모듈 초기화
     */
    async init() {
        this.initElements();
        this.bindEvents();
        this.loadFiltersFromState();
        
        console.log('[FilterManager] 모듈 초기화 완료');
    }

    /**
     * DOM 요소 초기화
     */
    initElements() {
        this.filterInput = document.getElementById('messageFilter'); // 메시지 필터 입력
        this.addFilterBtn = null; // 현재 HTML에 추가 버튼이 없으므로 null
        this.clearFiltersBtn = document.getElementById('clearFilters'); // 클리어 버튼
        this.filterTags = document.getElementById('filterTags'); // 활성 필터 컨테이너
        
        // 추가 필터 입력들
        this.levelFilter = document.getElementById('levelFilter');
        this.tagFilter = document.getElementById('tagFilter');
        this.pidFilter = document.getElementById('pidFilter');
        
        console.log('[FilterManager] DOM 요소 초기화:', {
            filterInput: !!this.filterInput,
            addFilterBtn: !!this.addFilterBtn,
            clearFiltersBtn: !!this.clearFiltersBtn,
            filterTags: !!this.filterTags
        });
    }

    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        // 필터 추가 버튼 (null 체크 추가)
        if (this.addFilterBtn) {
            this.addFilterBtn.addEventListener('click', () => {
                this.addFilter();
            });
        }

        // 엔터키로 필터 추가 (null 체크 추가)
        if (this.filterInput) {
            this.filterInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.addFilter();
                }
            });
        }

        // 레벨 필터 엔터키
        if (this.levelFilter) {
            this.levelFilter.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.addLevelFilter();
                }
            });
        }

        // 태그 필터 엔터키
        if (this.tagFilter) {
            this.tagFilter.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.addTagFilter();
                }
            });
        }

        // PID 필터 엔터키
        if (this.pidFilter) {
            this.pidFilter.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.addPidFilter();
                }
            });
        }

        // ESC로 모든 필터 삭제
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.clearAllFilters();
            }
        });

        // 모든 필터 삭제 버튼 (null 체크 추가)
        if (this.clearFiltersBtn) {
            this.clearFiltersBtn.addEventListener('click', () => {
                this.clearAllFilters();
            });
        }

        // 상태 변경 감시
        this.appState.watch('filters.active', () => {
            this.updateFilterTags();
            this.eventBus.publish('filter:changed', {});
        });
        
        console.log('[FilterManager] 이벤트 바인딩 완료');
    }

    /**
     * 상태에서 필터 로드
     */
    loadFiltersFromState() {
        this.updateFilterTags();
    }

    /**
     * 필터 추가
     */
    addFilter() {
        const filterText = this.filterInput.value.trim();
        if (!filterText) return;
        
        const activeFilters = this.appState.get('filters.active') || [];
        
        // 새로운 필터 객체 생성
        const newFilter = { type: 'message', value: filterText };
        
        // 중복 필터 체크 (객체 비교)
        const isDuplicate = activeFilters.some(f => f.type === newFilter.type && f.value === newFilter.value);
        if (isDuplicate) {
            this.filterInput.value = '';
            return;
        }
        
        // 필터 추가
        const newFilters = [...activeFilters, newFilter];
        this.appState.set('filters.active', newFilters);
        
        // 필터 기록에 추가 (메시지 필터만)
        this.addToHistory(filterText);
        
        // 입력 필드 초기화
        this.filterInput.value = '';
        
        console.log('[FilterManager] 필터 추가:', newFilter);
    }

    /**
     * 레벨 필터 추가
     */
    addLevelFilter() {
        const levelValue = this.levelFilter.value.trim();
        if (!levelValue) return;
        
        this.addFilterByType('level', levelValue);
        this.levelFilter.value = '';
    }

    /**
     * 태그 필터 추가
     */
    addTagFilter() {
        const tagValue = this.tagFilter.value.trim();
        if (!tagValue) return;
        
        this.addFilterByType('tag', tagValue);
        this.tagFilter.value = '';
    }

    /**
     * PID 필터 추가
     */
    addPidFilter() {
        const pidValue = this.pidFilter.value.trim();
        if (!pidValue) return;
        
        const pidNum = parseInt(pidValue, 10);
        if (isNaN(pidNum)) return;
        
        this.addFilterByType('pid', pidNum);
        this.pidFilter.value = '';
    }

    /**
     * 타입별 필터 추가 헬퍼
     */
    addFilterByType(type, value) {
        const activeFilters = this.appState.get('filters.active') || [];
        
        // 새로운 필터 객체 생성
        const newFilter = { type, value };
        
        // 중복 필터 체크 (객체 비교)
        const isDuplicate = activeFilters.some(f => f.type === newFilter.type && f.value === newFilter.value);
        if (isDuplicate) return;
        
        // 필터 추가
        const newFilters = [...activeFilters, newFilter];
        this.appState.set('filters.active', newFilters);
        
        console.log('[FilterManager] 필터 추가:', newFilter);
    }

    /**
     * 필터 제거
     */
    removeFilter(filterObj) {
        const activeFilters = this.appState.get('filters.active') || [];
        const newFilters = activeFilters.filter(f => !(f.type === filterObj.type && f.value === filterObj.value));
        
        this.appState.set('filters.active', newFilters);
        
        console.log('[FilterManager] 필터 제거:', filterObj);
    }

    /**
     * 모든 필터 삭제
     */
    clearAllFilters() {
        this.appState.set('filters.active', []);
        this.filterInput.value = '';
        
        console.log('[FilterManager] 모든 필터 삭제');
    }

    /**
     * 필터 기록에 추가
     */
    addToHistory(filterText) {
        const history = this.appState.get('filters.history') || [];
        
        // 중복 제거
        const newHistory = [filterText, ...history.filter(f => f !== filterText)];
        
        // 최대 50개까지만 유지
        if (newHistory.length > 50) {
            newHistory.splice(50);
        }
        
        this.appState.set('filters.history', newHistory);
    }

    /**
     * 필터 태그 UI 업데이트
     */
    updateFilterTags() {
        if (!this.filterTags) return;
        
        const activeFilters = this.appState.get('filters.active') || [];
        this.filterTags.innerHTML = '';
        
        activeFilters.forEach(filter => {
            const tag = document.createElement('span');
            tag.className = 'filter-tag';
            const filterLabel = `${filter.type}: ${this.escapeHtml(filter.value)}`;
            const filterObjStr = JSON.stringify(filter).replace(/"/g, '&quot;');
            tag.innerHTML = `
                ${filterLabel}
                <button onclick="window.filterManager.removeFilter(${filterObjStr})">×</button>
            `;
            this.filterTags.appendChild(tag);
        });
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
     * 모듈 정리
     */
    async destroy() {
        // 전역 참조 제거
        if (window.filterManager === this) {
            delete window.filterManager;
        }
        
        console.log('[FilterManager] 모듈 정리 완료');
    }
}
