import type { SectionDTO } from '../types/model.js';

export class ControlsView {
  constructor(
    private el: HTMLElement,
    private onClick: (id: string) => void,
  ) {}

  render(sections: SectionDTO[], toggles: { showLogs: boolean; showExplorer: boolean }) {
    this.el.innerHTML = '';
    sections.forEach((sec) => {
      const card = document.createElement('div');
      card.className = 'section-card';
      const h = document.createElement('h4');
      h.textContent = sec.title;
      card.appendChild(h);
      const body = document.createElement('div');
      body.className = 'section-body';
      sec.items.forEach((it) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.title = it.desc || it.label;
        b.textContent = it.label;
        if (it.id === 'panel.toggleLogs' && toggles.showLogs) b.classList.add('btn-on');
        if (it.id === 'panel.toggleExplorer' && toggles.showExplorer) b.classList.add('btn-on');
        b.addEventListener('click', () => this.onClick(it.id));
        body.appendChild(b);
      });
      card.appendChild(body);
      this.el.appendChild(card);
    });
  }
}
