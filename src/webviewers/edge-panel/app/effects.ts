import { HostBridge } from '../services/HostBridge.js';
import type { PanelStatePersist } from '../types/model.js';

export function sendReady(host: HostBridge) {
  host.post({ v: 1, type: 'ui.ready', payload: {} });
}

export function requestButtons(host: HostBridge) {
  host.post({ v: 1, type: 'ui.requestButtons', payload: {} });
}

export function savePanel(host: HostBridge, p: PanelStatePersist) {
  host.post({ v: 1, type: 'ui.savePanelState', payload: { panelState: p } });
}

export function toggleExplorer(host: HostBridge) {
  host.post({ v: 1, type: 'ui.toggleExplorer', payload: {} });
}
export function toggleLogs(host: HostBridge) {
  host.post({ v: 1, type: 'ui.toggleLogs', payload: {} });
}
