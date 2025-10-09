/**
 * TooltipManager - 메시지 상세 보기 팝업 관리
 * 
 * 기능:
 * - 더블클릭으로 즉시 메시지 전체 내용 팝업 표시
 * - 팝업 내 텍스트 선택 및 복사 기능
 * - 스마트 위치 조정 (화면 경계 고려)
 * - 단일클릭 다른 곳 클릭 시 또는 ESC키로 팝업 숨김
 */
export default class TooltipManager {
    constructor({ eventBus, appState, moduleLoader }) {
        this.eventBus = eventBus;
        this.appState = appState;
        this.moduleLoader = moduleLoader;
        
        // 툴팁 상태
        this.tooltip = null;
        this.isVisible = false;
        this.currentTrigger = null;
        
        // 설정
        this.maxWidth = 600;
        this.maxHeight = 400;
    }
    
    async init() {
        this.createTooltipElement();
        this.bindEvents();
        
        this.info('💬 TooltipManager 초기화 완료');
    }
    
    createTooltipElement() {
        // 기존 툴팁이 있다면 제거
        const existing = document.getElementById('messageTooltip');
        if (existing) {
            existing.remove();
        }
        
        // 새 툴팁 요소 생성
        this.tooltip = document.createElement('div');
        this.tooltip.id = 'messageTooltip';
        this.tooltip.className = 'message-tooltip hidden';
        this.tooltip.style.cssText = `
            position: absolute;
            background: #2d2d30;
            border: 1px solid #3e3e42;
            border-radius: 6px;
            max-width: ${this.maxWidth}px;
            max-height: ${this.maxHeight}px;
            z-index: 1000;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            overflow: hidden;
            pointer-events: auto;
            display: none;
        `;
        
        this.tooltip.innerHTML = `
            <div class="tooltip-header">
                <span class="tooltip-title">메시지 전체 내용</span>
                <button class="copy-btn" title="복사">📋 복사</button>
                <button class="tooltip-close" title="닫기" aria-label="툴팁 닫기">✕</button>
            </div>
            <div class="tooltip-content" tabindex="0">
                <!-- 메시지 내용이 여기에 표시됩니다 -->
            </div>
        `;
        
        document.body.appendChild(this.tooltip);
        
        // 툴팁 내부 요소들 참조
        this.tooltipHeader = this.tooltip.querySelector('.tooltip-header');
        this.tooltipTitle = this.tooltip.querySelector('.tooltip-title');
        this.tooltipContent = this.tooltip.querySelector('.tooltip-content');
        this.copyBtn = this.tooltip.querySelector('.copy-btn');
        this.closeBtn = this.tooltip.querySelector('.tooltip-close');
    }
    
    bindEvents() {
        // 로그 테이블에만 이벤트 바인딩 (더 구체적으로)
        const logTable = document.getElementById('logTable');
        if (logTable) {
            // 더블클릭으로 즉시 툴팁 표시
            logTable.addEventListener('dblclick', this.handleDoubleClick.bind(this), true);
            // 단일 클릭으로 툴팁 숨김 (다른 곳 클릭 시)
            logTable.addEventListener('click', this.handleSingleClick.bind(this), true);
        } else {
            // 테이블이 없으면 전체 문서에 바인딩 (fallback)
            document.addEventListener('dblclick', this.handleDoubleClick.bind(this), false);
            document.addEventListener('click', this.handleSingleClick.bind(this), false);
        }
        
        // 툴팁 내부 이벤트
        if (this.copyBtn) {
            this.copyBtn.addEventListener('click', this.handleCopyClick.bind(this));
        }
        
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', this.hideTooltip.bind(this));
        }
        
        // 키보드 이벤트
        document.addEventListener('keydown', this.handleKeyDown.bind(this));
        
        // 스크롤 시 툴팁 숨김
        document.addEventListener('scroll', this.hideTooltip.bind(this), true);
        
        // 윈도우 리사이즈 시 툴팁 위치 재조정
        window.addEventListener('resize', this.repositionTooltip.bind(this));
    }

    /**
     * 메시지 셀 더블클릭 이벤트 - 즉시 툴팁 표시
     */
    handleDoubleClick(e) {
        if (!e || !e.target) return;
        
        const messageCell = e.target.closest('.message-cell, .message');
        if (!messageCell) return;
        
        // 전체 메시지 내용 확인
        const fullMessage = this.getFullMessage(messageCell);
        if (!fullMessage) {
            this.info('📝 메시지 내용이 없어서 툴팁을 표시하지 않습니다');
            return; // 빈 메시지는 툴팁 표시하지 않음
        }
        
        // 브라우저 기본 더블클릭 동작 방지 (텍스트 선택 등)
        e.preventDefault();
        e.stopPropagation();
        
        // 즉시 툴팁 표시
        this.showTooltip(messageCell, fullMessage);
        
        this.info(`💬 더블클릭으로 툴팁 표시: ${fullMessage.substring(0, 50)}...`);
    }

    /**
     * 메시지 셀 단일클릭 이벤트 - 툴팁 숨김 (다른 곳 클릭 시)
     */
    handleSingleClick(e) {
        if (!e || !e.target) return;
        
        const messageCell = e.target.closest('.message-cell, .message');
        
        // 툴팁이 표시 중이고, 다른 셀이나 빈 곳을 클릭하면 숨김
        if (this.isVisible && (!messageCell || messageCell !== this.currentTrigger)) {
            this.hideTooltip();
        }
    }

    
    handleKeyDown(e) {
        if (e.key === 'Escape') {
            if (this.isVisible) {
                this.hideTooltip();
            }
        }
    }
    
    getFullMessage(messageCell) {
        // data-original-title에서 전체 메시지 가져오기 (우리가 임시 저장한 것)
        const originalTitle = messageCell.getAttribute('data-original-title');
        if (originalTitle) return originalTitle;
        
        // title 속성에서 전체 메시지 가져오기 (LogViewer에서 설정)
        const fullMessage = messageCell.title || messageCell.getAttribute('title');
        if (fullMessage) return fullMessage;
        
        // data-full-message 속성에서 전체 메시지 가져오기
        const dataMessage = messageCell.dataset.fullMessage;
        if (dataMessage) return dataMessage;
        
        // 속성이 없으면 텍스트 내용 사용
        return messageCell.textContent || messageCell.innerText || '';
    }
    
    
    showTooltip(triggerElement, fullMessage) {
        if (!triggerElement || !fullMessage) {
            this.error('❌ triggerElement 또는 fullMessage 없음');
            return;
        }
        
        // 현재 트리거 설정
        this.currentTrigger = triggerElement;
        
        // 툴팁 내용 설정
        this.tooltipContent.textContent = fullMessage;
        this.tooltipContent.title = ''; // 브라우저 기본 툴팁 제거
        
        // 툴팁 표시
        this.tooltip.classList.remove('hidden');
        this.tooltip.style.display = 'block';
        this.isVisible = true;
        
        // 위치 조정
        this.positionTooltip(triggerElement);
        
        // 텍스트 선택 가능하게 설정
        this.makeTextSelectable();
        
        // 이벤트 발행
        this.eventBus.publish('tooltip:shown', {
            element: triggerElement,
            message: fullMessage
        });
        
        this.info('💬 메시지 툴팁 표시 완료');
    }
    
    hideTooltip() {     
        if (!this.isVisible) {
            return;
        }
        
        this.tooltip.classList.add('hidden');
        this.tooltip.style.display = 'none';
        this.isVisible = false;
        this.currentTrigger = null;
        
        // 이벤트 발행
        this.eventBus.publish('tooltip:hidden', {});
        
        this.info('💬 메시지 툴팁 숨김 완료');
    }
    
    positionTooltip(triggerElement) {
        if (!triggerElement || !this.tooltip) return;
        
        const triggerRect = triggerElement.getBoundingClientRect();
        const tooltipRect = this.tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        let left = triggerRect.left;
        let top = triggerRect.bottom + 5; // 트리거 요소 아래쪽에 표시
        
        // 화면 우측 경계 확인
        if (left + tooltipRect.width > viewportWidth - 10) {
            left = viewportWidth - tooltipRect.width - 10;
        }
        
        // 화면 좌측 경계 확인
        if (left < 10) {
            left = 10;
        }
        
        // 화면 하단 경계 확인
        if (top + tooltipRect.height > viewportHeight - 10) {
            // 트리거 요소 위쪽에 표시
            top = triggerRect.top - tooltipRect.height - 5;
            
            // 위쪽에도 공간이 없으면 화면 상단에 맞춤
            if (top < 10) {
                top = 10;
            }
        }
        
        // 위치 적용
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = `${top}px`;
    }
    
    repositionTooltip() {
        if (this.isVisible && this.currentTrigger) {
            this.positionTooltip(this.currentTrigger);
        }
    }
    
    makeTextSelectable() {
        if (!this.tooltipContent) return;
        
        // 텍스트 선택 스타일 적용
        this.tooltipContent.style.cssText += `
            user-select: text;
            cursor: text;
            padding: 12px;
            color: #d4d4d4;
            font-family: 'Consolas', monospace;
            font-size: 12px;
            line-height: 1.4;
            overflow-y: auto;
            max-height: ${this.maxHeight - 60}px;
            white-space: pre-wrap;
            word-break: break-word;
        `;
        
        // 선택 영역 스타일
        const style = document.createElement('style');
        style.textContent = `
            .tooltip-content::selection {
                background-color: #4fc3f7;
                color: #1e1e1e;
            }
        `;
        
        if (!document.querySelector('#tooltip-selection-style')) {
            style.id = 'tooltip-selection-style';
            document.head.appendChild(style);
        }
    }
    
    handleCopyClick() {
        const text = this.tooltipContent.textContent;
        if (!text) return;
        
        this.copyToClipboard(text)
            .then(() => {
                this.showCopySuccess();
            })
            .catch(err => {
                console.error('복사 실패:', err);
                this.showCopyError();
            });
    }
    
    async copyToClipboard(text) {
        try {
            // 현대적인 Clipboard API 사용
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return;
            }
            
            // 폴백: 구식 방법
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            const result = document.execCommand('copy');
            document.body.removeChild(textArea);
            
            if (!result) {
                throw new Error('document.execCommand 실패');
            }
            
        } catch (err) {
            throw new Error(`클립보드 복사 실패: ${err.message}`);
        }
    }
    
    showCopySuccess() {
        if (!this.copyBtn) return;
        
        const originalText = this.copyBtn.textContent;
        this.copyBtn.textContent = '✅ 복사됨';
        this.copyBtn.classList.add('success');
        
        setTimeout(() => {
            this.copyBtn.textContent = originalText;
            this.copyBtn.classList.remove('success');
        }, 2000);
        
        console.log('💬 메시지 클립보드 복사 성공');
    }
    
    showCopyError() {
        if (!this.copyBtn) return;
        
        const originalText = this.copyBtn.textContent;
        this.copyBtn.textContent = '❌ 실패';
        this.copyBtn.classList.add('error');
        
        setTimeout(() => {
            this.copyBtn.textContent = originalText;
            this.copyBtn.classList.remove('error');
        }, 2000);
        
        console.log('💬 메시지 클립보드 복사 실패');
    }
    
    // 공개 API
    isTooltipVisible() {
        return this.isVisible;
    }
    
    getCurrentMessage() {
        return this.tooltipContent ? this.tooltipContent.textContent : null;
    }
    
    forceHide() {
        this.hideTooltip();
    }
    
    setShowDelay(delay) {
        this.showDelay = Math.max(0, delay);
    }
    
    getShowDelay() {
        return this.showDelay;
    }
    
    // 설정 저장/로드
    loadSettings() {
        const settings = this.appState.get('tooltip.settings');
        if (settings) {
            this.showDelay = settings.showDelay || this.showDelay;
            this.maxWidth = settings.maxWidth || this.maxWidth;
            this.maxHeight = settings.maxHeight || this.maxHeight;
        }
    }
    
    saveSettings() {
        this.appState.set('tooltip.settings', {
            showDelay: this.showDelay,
            maxWidth: this.maxWidth,
            maxHeight: this.maxHeight
        });
    }
    
    async destroy() {
        // 툴팁 숨기기
        this.hideTooltip();
        
        // DOM 요소 제거
        if (this.tooltip && this.tooltip.parentNode) {
            this.tooltip.parentNode.removeChild(this.tooltip);
        }
        
        // 스타일 정리
        const selectionStyle = document.getElementById('tooltip-selection-style');
        if (selectionStyle) {
            selectionStyle.remove();
        }
        
        // 설정 저장
        this.saveSettings();
        
        console.log('💬 TooltipManager 정리 완료');
    }
}
