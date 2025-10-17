import type { PanelStatePersist } from '../types/model.js';
import { HostBridge } from './HostBridge.js';

export class PersistService {
  constructor(private host: HostBridge) {}
  save(panelState: PanelStatePersist) {
    this.host.post({ v: 1, type: 'ui.savePanelState', payload: { panelState } });
  }
}
