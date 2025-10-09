/**
 * BookmarkManager - 북마크 관리 및 빠른 점프 기능
 * 
 * 기능:
 * - 더블클릭으로 북마크 추가/제거
 * - 사이드바에서 북마크 목록 관리
 * - 북마크 위치로 빠른 점프
 * - 북마크 영구 저장 (localStorage)
 */
export default class BookmarkManager {
    constructor({ eventBus, appState, moduleLoader }) {
        this.eventBus = eventBus;
        this.appState = appState;
        this.moduleLoader = moduleLoader;
        
        // 북마크 상태
        this.bookmarks = new Map(); // logId -> bookmark info
        this.isSidebarVisible = false;
        
        // DOM 요소들
        this.bookmarkToggleBtn = null;
        this.bookmarkSidebar = null;
        this.bookmarkList = null;
        this.bookmarkCounter = null;
        
        // 북마크 아이콘
        this.bookmarkIcon = '📖';
        this.unbookmarkIcon = '🔖';
    }
    
    async init() {
        this.initElements();
        this.bindEvents();
        this.loadBookmarks();
        this.updateBookmarkDisplay();
        
        console.log('📖 BookmarkManager 초기화 완료');
    }
    
    initElements() {
        this.bookmarkToggleBtn = document.getElementById('bookmarkToggle');
        this.bookmarkSidebar = document.querySelector('.bookmark-sidebar');
        this.bookmarkList = document.querySelector('.bookmark-list');
        this.bookmarkCounter = document.querySelector('.bookmark-counter');
        
        if (!this.bookmarkToggleBtn) {
            console.error('❌ 북마크 토글 버튼을 찾을 수 없습니다');
        }
    }
    
    bindEvents() {
        // 이벤트 구독
        this.eventBus.subscribe('log:received', this.handleNewLog.bind(this));
        this.eventBus.subscribe('log:double-click', this.handleLogDoubleClick.bind(this));
        
        // 북마크 토글 버튼
        if (this.bookmarkToggleBtn) {
            this.bookmarkToggleBtn.addEventListener('click', this.toggleSidebar.bind(this));
        }
        
        // 북마크 리스트 이벤트 (이벤트 위임)
        if (this.bookmarkList) {
            this.bookmarkList.addEventListener('dblclick', this.handleBookmarkDoubleClick.bind(this));
            this.bookmarkList.addEventListener('click', this.handleBookmarkClick.bind(this));
        }
        
        // 메인 로그 테이블 더블클릭 감지를 위한 이벤트 위임
        document.addEventListener('dblclick', this.handleMainLogDoubleClick.bind(this));
    }
    
    handleMainLogDoubleClick(e) {
        // 로그 행 더블클릭 감지
        const logRow = e.target.closest('.log-row');
        if (!logRow) return;
        
        const logId = logRow.dataset.logId;
        if (!logId) return;
        
        // 북마크 토글
        this.toggleBookmark(parseInt(logId));
        
        // 다른 핸들러들이 실행되지 않도록 이벤트 전파 중단
        e.stopPropagation();
    }
    
    handleLogDoubleClick(data) {
        const { logId } = data;
        this.toggleBookmark(logId);
    }
    
    handleNewLog(logEntry) {
        // 새 로그가 북마크된 경우 UI 업데이트
        if (this.bookmarks.has(logEntry.id)) {
            this.updateBookmarkDisplay();
        }
    }
    
    toggleBookmark(logId) {
        if (this.bookmarks.has(logId)) {
            this.removeBookmark(logId);
        } else {
            this.addBookmark(logId);
        }
    }
    
    addBookmark(logId) {
        // 로그 정보 가져오기
        const logEntry = this.getLogEntry(logId);
        if (!logEntry) {
            console.warn(`북마크 추가 실패: 로그 ID ${logId}를 찾을 수 없습니다`);
            return;
        }
        
        const bookmark = {
            id: logId,
            timestamp: logEntry.timestamp,
            level: logEntry.level,
            tag: logEntry.tag,
            message: logEntry.message,
            createdAt: new Date().toISOString(),
            title: this.generateBookmarkTitle(logEntry)
        };
        
        this.bookmarks.set(logId, bookmark);
        this.saveBookmarks();
        this.updateBookmarkDisplay();
        this.updateLogRowBookmarkIcon(logId, true);
        
        // 이벤트 발행
        this.eventBus.publish('bookmark:added', { logId, bookmark });
        
        console.log(`📖 북마크 추가: ${logId} - ${bookmark.title}`);
    }
    
    removeBookmark(logId) {
        const bookmark = this.bookmarks.get(logId);
        if (!bookmark) return;
        
        this.bookmarks.delete(logId);
        this.saveBookmarks();
        this.updateBookmarkDisplay();
        this.updateLogRowBookmarkIcon(logId, false);
        
        // 이벤트 발행
        this.eventBus.publish('bookmark:removed', { logId, bookmark });
        
        console.log(`📖 북마크 제거: ${logId} - ${bookmark.title}`);
    }
    
    generateBookmarkTitle(logEntry) {
        const timestamp = new Date(logEntry.timestamp).toLocaleTimeString('ko-KR', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
        
        const level = logEntry.level || '';
        const tag = logEntry.tag || '';
        const message = logEntry.message || '';
        
        // 메시지를 30자로 제한
        const truncatedMessage = message.length > 30 
            ? message.substring(0, 30) + '...' 
            : message;
        
        return `${timestamp} [${level}] ${tag}: ${truncatedMessage}`;
    }
    
    getLogEntry(logId) {
        // LogViewer에서 로그 정보 가져오기
        const logViewer = this.moduleLoader?.getModule('LogViewer');
        return logViewer?.getLogById(logId);
    }
    
    updateLogRowBookmarkIcon(logId, isBookmarked) {
        const logRow = document.querySelector(`[data-log-id="${logId}"]`);
        if (!logRow) return;
        
        const bookmarkCell = logRow.querySelector('.bookmark-cell');
        if (bookmarkCell) {
            bookmarkCell.textContent = isBookmarked ? this.bookmarkIcon : this.unbookmarkIcon;
            bookmarkCell.classList.toggle('bookmarked', isBookmarked);
        }
    }
    
    updateBookmarkDisplay() {
        this.updateBookmarkList();
        this.updateBookmarkCounter();
        this.updateToggleButton();
    }
    
    updateBookmarkList() {
        if (!this.bookmarkList) return;
        
        // 북마크를 시간순으로 정렬 (최신순)
        const sortedBookmarks = Array.from(this.bookmarks.values())
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        this.bookmarkList.innerHTML = '';
        
        if (sortedBookmarks.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'bookmark-empty';
            emptyMessage.textContent = '북마크된 로그가 없습니다';
            this.bookmarkList.appendChild(emptyMessage);
            return;
        }
        
        sortedBookmarks.forEach(bookmark => {
            const bookmarkItem = this.createBookmarkItem(bookmark);
            this.bookmarkList.appendChild(bookmarkItem);
        });
    }
    
    createBookmarkItem(bookmark) {
        const item = document.createElement('div');
        item.className = 'bookmark-item';
        item.dataset.logId = bookmark.id;
        
        const timestamp = new Date(bookmark.timestamp).toLocaleTimeString('ko-KR', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
        
        const levelClass = bookmark.level ? bookmark.level.toLowerCase() : '';
        
        item.innerHTML = `
            <div class="bookmark-header">
                <span class="bookmark-time">${timestamp}</span>
                <span class="bookmark-level ${levelClass}">${bookmark.level || ''}</span>
                <button class="bookmark-remove" title="북마크 제거">×</button>
            </div>
            <div class="bookmark-content">
                <div class="bookmark-tag">${bookmark.tag || ''}</div>
                <div class="bookmark-message" title="${bookmark.message}">${bookmark.message}</div>
            </div>
        `;
        
        return item;
    }
    
    updateBookmarkCounter() {
        const count = this.bookmarks.size;
        
        if (this.bookmarkCounter) {
            this.bookmarkCounter.textContent = count > 0 ? `(${count})` : '';
        }
        
        // 북마크 토글 버튼 텍스트 업데이트
        if (this.bookmarkToggleBtn) {
            const baseText = '📖 북마크';
            this.bookmarkToggleBtn.textContent = count > 0 ? `${baseText} (${count})` : baseText;
        }
    }
    
    updateToggleButton() {
        if (!this.bookmarkToggleBtn) return;
        
        this.bookmarkToggleBtn.classList.toggle('active', this.isSidebarVisible);
    }
    
    handleBookmarkDoubleClick(e) {
        const bookmarkItem = e.target.closest('.bookmark-item');
        if (!bookmarkItem) return;
        
        const logId = parseInt(bookmarkItem.dataset.logId);
        this.jumpToBookmark(logId);
    }
    
    handleBookmarkClick(e) {
        // 북마크 제거 버튼 클릭
        if (e.target.classList.contains('bookmark-remove')) {
            const bookmarkItem = e.target.closest('.bookmark-item');
            if (bookmarkItem) {
                const logId = parseInt(bookmarkItem.dataset.logId);
                this.removeBookmark(logId);
            }
            return;
        }
        
        // 북마크 아이템 단순 클릭 (선택만)
        const bookmarkItem = e.target.closest('.bookmark-item');
        if (bookmarkItem) {
            this.selectBookmarkItem(bookmarkItem);
        }
    }
    
    selectBookmarkItem(item) {
        // 기존 선택 해제
        document.querySelectorAll('.bookmark-item.selected').forEach(el => {
            el.classList.remove('selected');
        });
        
        // 새 아이템 선택
        item.classList.add('selected');
    }
    
    jumpToBookmark(logId) {
        const bookmark = this.bookmarks.get(logId);
        if (!bookmark) {
            console.warn(`북마크 점프 실패: 북마크 ID ${logId}를 찾을 수 없습니다`);
            return;
        }
        
        // 메인 로그 영역으로 스크롤
        this.eventBus.publish('log:jump-to', { logId });
        
        // 사이드바 닫기 (선택사항)
        // this.closeSidebar();
        
        console.log(`📖 북마크 이동: ${logId} - ${bookmark.title}`);
    }
    
    toggleSidebar() {
        this.isSidebarVisible = !this.isSidebarVisible;
        
        if (this.isSidebarVisible) {
            this.showSidebar();
        } else {
            this.hideSidebar();
        }
    }
    
    showSidebar() {
        this.isSidebarVisible = true;
        
        if (this.bookmarkSidebar) {
            this.bookmarkSidebar.classList.remove('hidden');
            this.bookmarkSidebar.classList.add('visible');
        }
        
        this.updateToggleButton();
        this.updateBookmarkDisplay();
        
        // 이벤트 발행
        this.eventBus.publish('bookmark:sidebar-shown', {});
        
        console.log('📖 북마크 사이드바 표시');
    }
    
    hideSidebar() {
        this.isSidebarVisible = false;
        
        if (this.bookmarkSidebar) {
            this.bookmarkSidebar.classList.add('hidden');
            this.bookmarkSidebar.classList.remove('visible');
        }
        
        this.updateToggleButton();
        
        // 이벤트 발행
        this.eventBus.publish('bookmark:sidebar-hidden', {});
        
        console.log('📖 북마크 사이드바 숨김');
    }
    
    closeSidebar() {
        this.hideSidebar();
    }
    
    loadBookmarks() {
        const saved = this.appState.get('bookmarks.list');
        if (saved && Array.isArray(saved)) {
            this.bookmarks.clear();
            saved.forEach(bookmark => {
                this.bookmarks.set(bookmark.id, bookmark);
            });
            console.log(`📖 북마크 로드 완료: ${saved.length}개`);
        }
    }
    
    saveBookmarks() {
        const bookmarksArray = Array.from(this.bookmarks.values());
        this.appState.set('bookmarks.list', bookmarksArray);
        console.log(`📖 북마크 저장 완료: ${bookmarksArray.length}개`);
    }
    
    // 북마크 내보내기/가져오기
    exportBookmarks() {
        const bookmarksArray = Array.from(this.bookmarks.values());
        const dataStr = JSON.stringify(bookmarksArray, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(dataBlob);
        link.download = `edgetool-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        
        console.log('📖 북마크 내보내기 완료');
    }
    
    importBookmarks(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const bookmarksArray = JSON.parse(e.target.result);
                if (Array.isArray(bookmarksArray)) {
                    // 기존 북마크와 병합
                    bookmarksArray.forEach(bookmark => {
                        this.bookmarks.set(bookmark.id, bookmark);
                    });
                    
                    this.saveBookmarks();
                    this.updateBookmarkDisplay();
                    
                    console.log(`📖 북마크 가져오기 완료: ${bookmarksArray.length}개`);
                }
            } catch (error) {
                console.error('북마크 가져오기 실패:', error);
            }
        };
        reader.readAsText(file);
    }
    
    // 공개 API
    getBookmarks() {
        return Array.from(this.bookmarks.values());
    }
    
    getBookmark(logId) {
        return this.bookmarks.get(logId);
    }
    
    hasBookmark(logId) {
        return this.bookmarks.has(logId);
    }
    
    getBookmarkCount() {
        return this.bookmarks.size;
    }
    
    clearAllBookmarks() {
        this.bookmarks.clear();
        this.saveBookmarks();
        this.updateBookmarkDisplay();
        
        // 모든 로그 행의 북마크 아이콘 업데이트
        document.querySelectorAll('.log-row').forEach(row => {
            const logId = parseInt(row.dataset.logId);
            this.updateLogRowBookmarkIcon(logId, false);
        });
        
        console.log('📖 모든 북마크 삭제');
    }
    
    async destroy() {
        // 이벤트 구독 해제
        this.eventBus.unsubscribe('log:received', this.handleNewLog.bind(this));
        this.eventBus.unsubscribe('log:double-click', this.handleLogDoubleClick.bind(this));
        
        // 사이드바 숨기기
        this.hideSidebar();
        
        // 북마크 저장
        this.saveBookmarks();
        
        console.log('📖 BookmarkManager 정리 완료');
    }
}
