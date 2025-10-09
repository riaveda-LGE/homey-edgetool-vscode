/**
 * SearchManager - 화면 분할 검색 및 결과 관리
 * 
 * 기능:
 * - 실시간 검색 (Ctrl+F)
 * - 상하 분할 화면 (메인 로그 + 검색 결과)
 * - 검색 결과 네비게이션 (이전/다음)
 * - 검색 결과에서 메인 로그로 점프
 */
export default class SearchManager {
    constructor({ eventBus, appState, moduleLoader }) {
        this.eventBus = eventBus;
        this.appState = appState;
        this.moduleLoader = moduleLoader;
        
        // 검색 상태
        this.searchResults = [];
        this.currentResultIndex = -1;
        this.isSearchActive = false;
        this.searchQuery = '';
        
        // DOM 요소들
        this.searchInput = null;
        this.searchResultsPanel = null;
        this.searchResultsBody = null;
        this.searchCounter = null;
        
        // 검색 옵션
        this.searchOptions = {
            caseSensitive: false,
            useRegex: false,
            searchInMessage: true,
            searchInLevel: true,
            searchInTag: true
        };
    }
    
    async init() {
        this.initElements();
        this.bindEvents();
        this.loadSearchOptions();
        
        // 키보드 단축키 등록
        this.registerKeyboardShortcuts();
        
        console.log('🔍 SearchManager 초기화 완료');
    }
    
    initElements() {
        this.searchInput = document.querySelector('.search-input');
        this.searchResultsPanel = document.querySelector('.search-results-panel');
        this.searchResultsBody = document.getElementById('searchResultsBody');
        this.searchCounter = document.querySelector('.search-results-count');
        
        // 검색 버튼들
        this.prevBtn = document.querySelector('.search-prev');
        this.nextBtn = document.querySelector('.search-next');
        this.closeSearchBtn = document.querySelector('.search-close');
        
        if (!this.searchInput) {
            console.error('❌ 검색 입력 요소를 찾을 수 없습니다');
        }
    }
    
    bindEvents() {
        // 이벤트 구독
        this.eventBus.subscribe('log:received', this.handleNewLog.bind(this));
        this.eventBus.subscribe('filter:changed', this.handleFilterChange.bind(this));
        
        // 검색 입력 이벤트
        if (this.searchInput) {
            this.searchInput.addEventListener('input', this.handleSearchInput.bind(this));
            this.searchInput.addEventListener('keydown', this.handleSearchKeydown.bind(this));
            this.searchInput.addEventListener('focus', this.handleSearchFocus.bind(this));
            this.searchInput.addEventListener('blur', this.handleSearchBlur.bind(this));
        }
        
        // 검색 네비게이션 버튼
        if (this.prevBtn) this.prevBtn.addEventListener('click', this.navigatePrevious.bind(this));
        if (this.nextBtn) this.nextBtn.addEventListener('click', this.navigateNext.bind(this));
        if (this.closeSearchBtn) this.closeSearchBtn.addEventListener('click', this.closeSearch.bind(this));
        
        // 검색 결과 더블클릭으로 메인 로그 이동
        if (this.searchResultsBody) {
            this.searchResultsBody.addEventListener('dblclick', this.handleResultDoubleClick.bind(this));
        }
    }
    
    registerKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+F: 검색 활성화
            if (e.ctrlKey && e.key === 'f') {
                e.preventDefault();
                this.activateSearch();
            }
            
            // ESC: 검색 닫기
            if (e.key === 'Escape' && this.isSearchActive) {
                this.closeSearch();
            }
            
            // F3 또는 Ctrl+G: 다음 결과
            if ((e.key === 'F3' || (e.ctrlKey && e.key === 'g')) && this.isSearchActive) {
                e.preventDefault();
                if (e.shiftKey) {
                    this.navigatePrevious();
                } else {
                    this.navigateNext();
                }
            }
        });
    }
    
    activateSearch() {
        this.isSearchActive = true;
        
        if (this.searchInput) {
            this.searchInput.focus();
            this.searchInput.select();
        }
        
        // 검색 패널 표시
        if (this.searchResultsPanel) {
            this.searchResultsPanel.classList.remove('hidden');
        }
        
        // 이벤트 발행
        this.eventBus.publish('search:activated', {});
        
        console.log('🔍 검색 모드 활성화');
    }
    
    closeSearch() {
        this.isSearchActive = false;
        this.searchQuery = '';
        this.searchResults = [];
        this.currentResultIndex = -1;
        
        if (this.searchInput) {
            this.searchInput.value = '';
            this.searchInput.blur();
        }
        
        // 검색 패널 숨김
        if (this.searchResultsPanel) {
            this.searchResultsPanel.classList.add('hidden');
        }
        
        // 검색 하이라이트 제거
        this.clearSearchHighlights();
        
        // 이벤트 발행
        this.eventBus.publish('search:closed', {});
        
        console.log('🔍 검색 모드 종료');
    }
    
    handleSearchInput(e) {
        const query = e.target.value.trim();
        this.searchQuery = query;
        
        if (query.length === 0) {
            this.clearSearchResults();
            return;
        }
        
        // 실시간 검색 (디바운싱)
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.performSearch(query);
        }, 300);
    }
    
    handleSearchKeydown(e) {
        switch (e.key) {
            case 'Enter':
                e.preventDefault();
                if (e.shiftKey) {
                    this.navigatePrevious();
                } else {
                    this.navigateNext();
                }
                break;
            case 'Escape':
                this.closeSearch();
                break;
        }
    }
    
    handleSearchFocus() {
        this.activateSearch();
    }
    
    handleSearchBlur() {
        // 잠시 후 검색 패널이 포커스를 받지 않으면 닫기
        setTimeout(() => {
            if (!this.searchResultsPanel?.matches(':hover') && 
                !this.searchInput?.matches(':focus')) {
                // 검색 패널은 열어두되 하이라이트만 제거
                this.clearSearchHighlights();
            }
        }, 200);
    }
    
    handleNewLog(logEntry) {
        // 활성 검색이 있으면 새 로그에도 검색 적용
        if (this.isSearchActive && this.searchQuery) {
            if (this.matchesSearch(logEntry, this.searchQuery)) {
                this.searchResults.push(logEntry);
                this.updateSearchResults();
            }
        }
    }
    
    handleFilterChange() {
        // 필터 변경시 검색 결과도 다시 계산
        if (this.isSearchActive && this.searchQuery) {
            this.performSearch(this.searchQuery);
        }
    }
    
    performSearch(query) {
        // 현재 필터된 로그들을 대상으로 검색
        const allLogs = this.getAllVisibleLogs();
        
        this.searchResults = allLogs.filter(log => this.matchesSearch(log, query));
        this.currentResultIndex = this.searchResults.length > 0 ? 0 : -1;
        
        this.updateSearchResults();
        this.updateSearchHighlights();
        
        // 검색 완료 이벤트
        this.eventBus.publish('search:completed', {
            query: query,
            results: this.searchResults,
            count: this.searchResults.length
        });
        
        console.log(`🔍 검색 완료: "${query}" - ${this.searchResults.length}개 결과`);
    }
    
    matchesSearch(logEntry, query) {
        if (!query) return false;
        
        const searchText = query.toLowerCase();
        const options = this.searchOptions;
        
        // 정규식 검색
        if (options.useRegex) {
            try {
                const regex = new RegExp(query, options.caseSensitive ? 'g' : 'gi');
                return this.testRegexMatch(logEntry, regex);
            } catch (e) {
                console.warn('정규식 오류:', e.message);
                return false;
            }
        }
        
        // 일반 텍스트 검색
        const getMessage = (text) => options.caseSensitive ? text : text.toLowerCase();
        
        if (options.searchInMessage && logEntry.message) {
            if (getMessage(logEntry.message).includes(searchText)) return true;
        }
        
        if (options.searchInLevel && logEntry.level) {
            if (getMessage(logEntry.level).includes(searchText)) return true;
        }
        
        if (options.searchInTag && logEntry.tag) {
            if (getMessage(logEntry.tag).includes(searchText)) return true;
        }
        
        return false;
    }
    
    testRegexMatch(logEntry, regex) {
        const fields = [];
        if (this.searchOptions.searchInMessage && logEntry.message) fields.push(logEntry.message);
        if (this.searchOptions.searchInLevel && logEntry.level) fields.push(logEntry.level);
        if (this.searchOptions.searchInTag && logEntry.tag) fields.push(logEntry.tag);
        
        return fields.some(field => regex.test(field));
    }
    
    getAllVisibleLogs() {
        // LogViewer에서 현재 표시 중인 로그들 가져오기
        const logViewer = this.moduleLoader?.getModule('LogViewer');
        return logViewer?.getVisibleLogs() || [];
    }
    
    updateSearchResults() {
        if (!this.searchResultsBody) return;
        
        // 검색 결과 테이블 업데이트
        this.searchResultsBody.innerHTML = '';
        
        this.searchResults.forEach((logEntry, index) => {
            const row = this.createSearchResultRow(logEntry, index);
            this.searchResultsBody.appendChild(row);
        });
        
        // 검색 카운터 업데이트
        this.updateSearchCounter();
        
        // 현재 선택된 결과 하이라이트
        this.highlightCurrentResult();
    }
    
    createSearchResultRow(logEntry, index) {
        const row = document.createElement('tr');
        row.className = 'search-result-row';
        row.dataset.resultIndex = index;
        row.dataset.logId = logEntry.id;
        
        // 검색어 하이라이트 적용
        const highlightedMessage = this.highlightSearchTerms(logEntry.message || '', this.searchQuery);
        
        row.innerHTML = `
            <td class="search-result-index">${logEntry.index}</td>
            <td class="search-result-time">${this.formatTime(logEntry.timestamp)}</td>
            <td class="search-result-level ${logEntry.level?.toLowerCase() || ''}" style="display: none;">${logEntry.level || ''}</td>
            <td class="search-result-source">${logEntry.source || ''}</td>
            <td class="search-result-tag">${logEntry.tag || ''}</td>
            <td class="search-result-message">${highlightedMessage}</td>
        `;
        
        return row;
    }
    
    highlightSearchTerms(text, query) {
        if (!query || !text) return text;
        
        if (this.searchOptions.useRegex) {
            try {
                const regex = new RegExp(query, this.searchOptions.caseSensitive ? 'g' : 'gi');
                return text.replace(regex, '<mark class="search-highlight">$&</mark>');
            } catch (e) {
                return text;
            }
        }
        
        const flags = this.searchOptions.caseSensitive ? 'g' : 'gi';
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedQuery, flags);
        
        return text.replace(regex, '<mark class="search-highlight">$&</mark>');
    }
    
    formatTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        return date.toLocaleTimeString('ko-KR', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
    }
    
    updateSearchCounter() {
        if (!this.searchCounter) return;
        
        const total = this.searchResults.length;
        const current = this.currentResultIndex >= 0 ? this.currentResultIndex + 1 : 0;
        
        this.searchCounter.textContent = `${current}/${total}`;
        
        // 네비게이션 버튼 상태 업데이트
        if (this.prevBtn) this.prevBtn.disabled = current <= 1;
        if (this.nextBtn) this.nextBtn.disabled = current >= total;
    }
    
    navigateNext() {
        if (this.searchResults.length === 0) return;
        
        this.currentResultIndex = (this.currentResultIndex + 1) % this.searchResults.length;
        this.jumpToResult(this.currentResultIndex);
    }
    
    navigatePrevious() {
        if (this.searchResults.length === 0) return;
        
        this.currentResultIndex = this.currentResultIndex <= 0 
            ? this.searchResults.length - 1 
            : this.currentResultIndex - 1;
        this.jumpToResult(this.currentResultIndex);
    }
    
    jumpToResult(index) {
        if (index < 0 || index >= this.searchResults.length) return;
        
        this.currentResultIndex = index;
        const logEntry = this.searchResults[index];
        
        // 메인 로그 영역에서 해당 로그로 스크롤
        this.eventBus.publish('log:jump-to', { logId: logEntry.id });
        
        // 검색 결과 패널에서도 선택 표시
        this.highlightCurrentResult();
        this.updateSearchCounter();
        
        console.log(`🔍 검색 결과 이동: ${index + 1}/${this.searchResults.length}`);
    }
    
    highlightCurrentResult() {
        // 기존 하이라이트 제거
        document.querySelectorAll('.search-result-row.current').forEach(row => {
            row.classList.remove('current');
        });
        
        // 현재 결과 하이라이트
        if (this.currentResultIndex >= 0) {
            const currentRow = this.searchResultsBody?.querySelector(
                `[data-result-index="${this.currentResultIndex}"]`
            );
            if (currentRow) {
                currentRow.classList.add('current');
                currentRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }
    
    handleResultDoubleClick(e) {
        const row = e.target.closest('.search-result-row');
        if (!row) return;
        
        const resultIndex = parseInt(row.dataset.resultIndex);
        this.jumpToResult(resultIndex);
    }
    
    updateSearchHighlights() {
        // 메인 로그 영역의 검색어 하이라이트 업데이트
        this.eventBus.publish('search:highlight-update', {
            query: this.searchQuery,
            options: this.searchOptions
        });
    }
    
    clearSearchHighlights() {
        this.eventBus.publish('search:highlight-clear', {});
    }
    
    clearSearchResults() {
        this.searchResults = [];
        this.currentResultIndex = -1;
        
        if (this.searchResultsBody) {
            this.searchResultsBody.innerHTML = '';
        }
        
        this.updateSearchCounter();
        this.clearSearchHighlights();
    }
    
    loadSearchOptions() {
        const savedOptions = this.appState.get('search.options');
        if (savedOptions) {
            this.searchOptions = { ...this.searchOptions, ...savedOptions };
        }
    }
    
    saveSearchOptions() {
        this.appState.set('search.options', this.searchOptions);
    }
    
    // 공개 API
    getSearchResults() {
        return this.searchResults;
    }
    
    getCurrentResult() {
        return this.currentResultIndex >= 0 ? this.searchResults[this.currentResultIndex] : null;
    }
    
    isActive() {
        return this.isSearchActive;
    }
    
    async destroy() {
        // 이벤트 구독 해제
        this.eventBus.unsubscribe('log:received', this.handleNewLog.bind(this));
        this.eventBus.unsubscribe('filter:changed', this.handleFilterChange.bind(this));
        
        // 검색 상태 정리
        this.closeSearch();
        
        console.log('🔍 SearchManager 정리 완료');
    }
}
