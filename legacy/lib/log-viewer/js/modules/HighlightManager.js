/**
 * HighlightManager - 패턴 기반 하이라이트 관리 (최대 5개 규칙)
 * 
 * 기능:
 * - 패턴 기반 메시지 하이라이트 (최대 5개 규칙)
 * - 다양한 색상 지원 (빨강, 노랑, 초록, 파랑, 보라)
 * - 정규식 패턴 지원
 * - 하이라이트 규칙 관리 UI
 * - 실시간 하이라이트 적용
 */
export default class HighlightManager {
    constructor({ eventBus, appState, moduleLoader }) {
        this.eventBus = eventBus;
        this.appState = appState;
        this.moduleLoader = moduleLoader;
        
        // 하이라이트 상태
        this.highlightRules = []; // 최대 5개
        this.maxRules = 5;
        this.isModalOpen = false;
        
        // DOM 요소들
        this.highlightBtn = null;
        this.highlightModal = null;
        this.rulesContainer = null;
        this.addRuleBtn = null;
        this.ruleCounter = null;
        
        // 색상 옵션
        this.colors = [
            { value: 'red', label: '🔴 빨강', class: 'highlight-red' },
            { value: 'yellow', label: '🟡 노랑', class: 'highlight-yellow' },
            { value: 'green', label: '🟢 초록', class: 'highlight-green' },
            { value: 'blue', label: '🔵 파랑', class: 'highlight-blue' },
            { value: 'purple', label: '🟣 보라', class: 'highlight-purple' }
        ];
    }
    
    async init() {
        this.initElements();
        this.bindEvents();
        this.loadHighlightRules();
        this.updateRulesDisplay();
        
        console.log('🎨 HighlightManager 초기화 완료');
    }
    
    initElements() {
        this.highlightBtn = document.getElementById('highlightBtn');
        this.highlightModal = document.getElementById('highlightModal');
        this.rulesContainer = document.getElementById('highlightRules');
        this.addRuleBtn = document.getElementById('addHighlightRule');
        this.ruleCounter = document.querySelector('.rule-count');
        
        if (!this.highlightBtn) {
            console.error('❌ 하이라이트 버튼을 찾을 수 없습니다');
        }
    }
    
    bindEvents() {
        // 이벤트 구독
        this.eventBus.subscribe('log:received', this.handleNewLog.bind(this));
        
        // 하이라이트 버튼
        if (this.highlightBtn) {
            this.highlightBtn.addEventListener('click', this.showModal.bind(this));
        }
        
        // 모달 관련 이벤트
        if (this.highlightModal) {
            // 모달 닫기 (배경 클릭)
            this.highlightModal.addEventListener('click', (e) => {
                if (e.target === this.highlightModal) {
                    this.hideModal();
                }
            });
            
            // X 버튼으로 닫기
            const closeBtn = this.highlightModal.querySelector('.modal-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', this.hideModal.bind(this));
            }
            
            // 모달 내부 클릭시 전파 중단
            const modalContent = this.highlightModal.querySelector('.modal-content');
            if (modalContent) {
                modalContent.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
            }
        }
        
        // 규칙 추가 버튼
        if (this.addRuleBtn) {
            this.addRuleBtn.addEventListener('click', this.addRule.bind(this));
        }
        
        // 규칙 컨테이너 이벤트 위임
        if (this.rulesContainer) {
            this.rulesContainer.addEventListener('input', this.handleRuleInput.bind(this));
            this.rulesContainer.addEventListener('change', this.handleRuleChange.bind(this));
            this.rulesContainer.addEventListener('click', this.handleRuleClick.bind(this));
        }
        
        // ESC 키로 모달 닫기
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isModalOpen) {
                this.hideModal();
            }
        });
    }
    
    handleNewLog(logEntry) {
        // 새 로그에 하이라이트 적용
        this.applyHighlightsToLog(logEntry);
    }
    
    showModal() {
        this.isModalOpen = true;
        
        if (this.highlightModal) {
            this.highlightModal.classList.remove('hidden');
            this.highlightModal.style.display = 'flex';
        }
        
        this.updateRulesDisplay();
        
        // 첫 번째 입력 필드에 포커스
        const firstInput = this.rulesContainer?.querySelector('.pattern-input');
        if (firstInput) {
            setTimeout(() => firstInput.focus(), 100);
        }
        
        console.log('🎨 하이라이트 설정 모달 열림');
    }
    
    hideModal() {
        this.isModalOpen = false;
        
        if (this.highlightModal) {
            this.highlightModal.classList.add('hidden');
            this.highlightModal.style.display = 'none';
        }
        
        // 변경사항 저장 및 적용
        this.saveHighlightRules();
        this.applyAllHighlights();
        
        console.log('🎨 하이라이트 설정 모달 닫힘');
    }
    
    addRule() {
        if (this.highlightRules.length >= this.maxRules) {
            console.warn(`최대 ${this.maxRules}개의 하이라이트 규칙만 설정할 수 있습니다`);
            return;
        }
        
        const newRule = {
            id: Date.now(),
            pattern: '',
            color: this.getNextAvailableColor(),
            enabled: true,
            isRegex: false
        };
        
        this.highlightRules.push(newRule);
        this.updateRulesDisplay();
        
        // 새 규칙의 입력 필드에 포커스
        setTimeout(() => {
            const newInput = this.rulesContainer?.querySelector(`[data-rule-id="${newRule.id}"] .pattern-input`);
            if (newInput) newInput.focus();
        }, 100);
        
        console.log('🎨 새 하이라이트 규칙 추가');
    }
    
    removeRule(ruleId) {
        this.highlightRules = this.highlightRules.filter(rule => rule.id !== ruleId);
        this.updateRulesDisplay();
        this.applyAllHighlights();
        
        console.log(`🎨 하이라이트 규칙 제거: ${ruleId}`);
    }
    
    getNextAvailableColor() {
        const usedColors = this.highlightRules.map(rule => rule.color);
        const availableColor = this.colors.find(color => !usedColors.includes(color.value));
        return availableColor ? availableColor.value : this.colors[0].value;
    }
    
    updateRulesDisplay() {
        if (!this.rulesContainer) return;
        
        this.rulesContainer.innerHTML = '';
        
        // 기존 규칙들 표시
        this.highlightRules.forEach(rule => {
            const ruleElement = this.createRuleElement(rule);
            this.rulesContainer.appendChild(ruleElement);
        });
        
        // 빈 규칙 슬롯 표시 (최대 5개까지)
        const emptySlots = this.maxRules - this.highlightRules.length;
        for (let i = 0; i < emptySlots; i++) {
            const emptyRule = this.createEmptyRuleElement(this.highlightRules.length + i + 1);
            this.rulesContainer.appendChild(emptyRule);
        }
        
        this.updateRuleCounter();
        this.updateAddButton();
    }
    
    createRuleElement(rule) {
        const div = document.createElement('div');
        div.className = 'highlight-rule';
        div.dataset.ruleId = rule.id;
        
        const ruleNumber = this.highlightRules.indexOf(rule) + 1;
        const colorOptions = this.colors.map(color => 
            `<option value="${color.value}" ${color.value === rule.color ? 'selected' : ''}>${color.label}</option>`
        ).join('');
        
        div.innerHTML = `
            <span class="rule-label">규칙 ${ruleNumber}:</span>
            <input type="text" 
                   class="pattern-input" 
                   placeholder="검색 패턴..." 
                   value="${rule.pattern}"
                   title="하이라이트할 패턴을 입력하세요">
            <select class="color-picker" title="하이라이트 색상 선택">
                ${colorOptions}
            </select>
            <label class="regex-toggle" title="정규식 사용">
                <input type="checkbox" ${rule.isRegex ? 'checked' : ''}> 정규식
            </label>
            <label class="enabled-toggle" title="규칙 활성화">
                <input type="checkbox" ${rule.enabled ? 'checked' : ''}> 활성
            </label>
            <button class="delete-rule" title="규칙 삭제">삭제</button>
        `;
        
        return div;
    }
    
    createEmptyRuleElement(ruleNumber) {
        const div = document.createElement('div');
        div.className = 'highlight-rule empty';
        
        div.innerHTML = `
            <span class="rule-label">규칙 ${ruleNumber}:</span>
            <input type="text" 
                   class="pattern-input" 
                   placeholder="새 규칙을 추가하려면 여기에 입력..." 
                   disabled>
            <select class="color-picker" disabled>
                <option>색상 선택</option>
            </select>
            <label class="regex-toggle">
                <input type="checkbox" disabled> 정규식
            </label>
            <label class="enabled-toggle">
                <input type="checkbox" disabled> 활성
            </label>
            <button class="delete-rule" disabled>삭제</button>
        `;
        
        return div;
    }
    
    updateRuleCounter() {
        if (this.ruleCounter) {
            this.ruleCounter.textContent = `규칙 수: ${this.highlightRules.length}/${this.maxRules}`;
        }
    }
    
    updateAddButton() {
        if (this.addRuleBtn) {
            this.addRuleBtn.disabled = this.highlightRules.length >= this.maxRules;
            this.addRuleBtn.textContent = this.highlightRules.length >= this.maxRules 
                ? '최대 규칙 수 도달' 
                : '규칙 추가';
        }
    }
    
    handleRuleInput(e) {
        if (!e.target.classList.contains('pattern-input')) return;
        
        const ruleElement = e.target.closest('.highlight-rule');
        if (!ruleElement || ruleElement.classList.contains('empty')) return;
        
        const ruleId = parseInt(ruleElement.dataset.ruleId);
        const rule = this.highlightRules.find(r => r.id === ruleId);
        
        if (rule) {
            rule.pattern = e.target.value;
            
            // 실시간 하이라이트 적용 (디바운싱)
            clearTimeout(this.highlightTimeout);
            this.highlightTimeout = setTimeout(() => {
                this.applyAllHighlights();
            }, 500);
        }
    }
    
    handleRuleChange(e) {
        const ruleElement = e.target.closest('.highlight-rule');
        if (!ruleElement || ruleElement.classList.contains('empty')) return;
        
        const ruleId = parseInt(ruleElement.dataset.ruleId);
        const rule = this.highlightRules.find(r => r.id === ruleId);
        
        if (!rule) return;
        
        if (e.target.classList.contains('color-picker')) {
            rule.color = e.target.value;
        } else if (e.target.type === 'checkbox') {
            if (e.target.closest('.regex-toggle')) {
                rule.isRegex = e.target.checked;
            } else if (e.target.closest('.enabled-toggle')) {
                rule.enabled = e.target.checked;
            }
        }
        
        this.applyAllHighlights();
    }
    
    handleRuleClick(e) {
        if (e.target.classList.contains('delete-rule')) {
            const ruleElement = e.target.closest('.highlight-rule');
            if (ruleElement && !ruleElement.classList.contains('empty')) {
                const ruleId = parseInt(ruleElement.dataset.ruleId);
                this.removeRule(ruleId);
            }
        }
    }
    
    applyAllHighlights() {
        // 모든 로그 행에 하이라이트 적용
        this.eventBus.publish('highlight:apply-all', {
            rules: this.getActiveRules()
        });
    }
    
    applyHighlightsToLog(logEntry) {
        // 특정 로그에 하이라이트 적용
        this.eventBus.publish('highlight:apply-to-log', {
            logEntry,
            rules: this.getActiveRules()
        });
    }
    
    applyHighlightsToText(text, logEntry = null) {
        if (!text) return text;
        
        let highlightedText = text;
        const activeRules = this.getActiveRules();
        
        // 각 규칙을 순서대로 적용
        activeRules.forEach(rule => {
            highlightedText = this.applyRuleToText(highlightedText, rule);
        });
        
        return highlightedText;
    }
    
    applyRuleToText(text, rule) {
        if (!text || !rule.pattern) return text;
        
        try {
            let regex;
            
            if (rule.isRegex) {
                // 정규식 패턴
                regex = new RegExp(rule.pattern, 'gi');
            } else {
                // 일반 텍스트 패턴 (특수문자 이스케이프)
                const escapedPattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(escapedPattern, 'gi');
            }
            
            const colorClass = this.getColorClass(rule.color);
            const replacement = `<span class="${colorClass}">$&</span>`;
            
            return text.replace(regex, replacement);
            
        } catch (error) {
            console.warn(`하이라이트 규칙 적용 오류 (${rule.pattern}):`, error.message);
            return text;
        }
    }
    
    getColorClass(colorValue) {
        const color = this.colors.find(c => c.value === colorValue);
        return color ? color.class : this.colors[0].class;
    }
    
    getActiveRules() {
        return this.highlightRules.filter(rule => 
            rule.enabled && 
            rule.pattern && 
            rule.pattern.trim().length > 0
        );
    }
    
    loadHighlightRules() {
        const saved = this.appState.get('highlight.rules');
        if (saved && Array.isArray(saved)) {
            this.highlightRules = saved.map(rule => ({
                ...rule,
                id: rule.id || Date.now() + Math.random()
            }));
            console.log(`🎨 하이라이트 규칙 로드 완료: ${saved.length}개`);
        }
    }
    
    saveHighlightRules() {
        this.appState.set('highlight.rules', this.highlightRules);
        console.log(`🎨 하이라이트 규칙 저장 완료: ${this.highlightRules.length}개`);
    }
    
    // 미리 정의된 규칙 템플릿
    addPredefinedRules() {
        const templates = [
            { pattern: 'ERROR|ERRO|FAIL', color: 'red', isRegex: true, name: '에러 패턴' },
            { pattern: 'WARN|WARNING', color: 'yellow', isRegex: true, name: '경고 패턴' },
            { pattern: 'INFO|SUCCESS', color: 'green', isRegex: true, name: '정보 패턴' },
            { pattern: 'DEBUG|TRACE', color: 'blue', isRegex: true, name: '디버그 패턴' },
            { pattern: 'CRITICAL|FATAL', color: 'purple', isRegex: true, name: '치명적 오류' }
        ];
        
        templates.forEach(template => {
            if (this.highlightRules.length < this.maxRules) {
                const rule = {
                    id: Date.now() + Math.random(),
                    pattern: template.pattern,
                    color: template.color,
                    enabled: true,
                    isRegex: template.isRegex
                };
                this.highlightRules.push(rule);
            }
        });
        
        this.updateRulesDisplay();
        this.saveHighlightRules();
        this.applyAllHighlights();
        
        console.log('🎨 미리 정의된 하이라이트 규칙 추가');
    }
    
    clearAllRules() {
        this.highlightRules = [];
        this.updateRulesDisplay();
        this.saveHighlightRules();
        this.applyAllHighlights();
        
        console.log('🎨 모든 하이라이트 규칙 삭제');
    }
    
    // 규칙 내보내기/가져오기
    exportRules() {
        const dataStr = JSON.stringify(this.highlightRules, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(dataBlob);
        link.download = `edgetool-highlight-rules-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        
        console.log('🎨 하이라이트 규칙 내보내기 완료');
    }
    
    importRules(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const rules = JSON.parse(e.target.result);
                if (Array.isArray(rules)) {
                    this.highlightRules = rules.slice(0, this.maxRules); // 최대 5개만
                    this.updateRulesDisplay();
                    this.saveHighlightRules();
                    this.applyAllHighlights();
                    
                    console.log(`🎨 하이라이트 규칙 가져오기 완료: ${rules.length}개`);
                }
            } catch (error) {
                console.error('하이라이트 규칙 가져오기 실패:', error);
            }
        };
        reader.readAsText(file);
    }
    
    // 공개 API
    getRules() {
        return [...this.highlightRules];
    }
    
    getActiveRuleCount() {
        return this.getActiveRules().length;
    }
    
    getTotalRuleCount() {
        return this.highlightRules.length;
    }
    
    isModalVisible() {
        return this.isModalOpen;
    }
    
    async destroy() {
        // 이벤트 구독 해제
        this.eventBus.unsubscribe('log:received', this.handleNewLog.bind(this));
        
        // 모달 닫기
        this.hideModal();
        
        // 하이라이트 규칙 저장
        this.saveHighlightRules();
        
        console.log('🎨 HighlightManager 정리 완료');
    }
}
