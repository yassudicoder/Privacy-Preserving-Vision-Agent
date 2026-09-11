/**
 * The panel: what was redacted, and what it cost. Pure state + a thin view.
 */
export { reducePanel, reduceAll, initialPanelState } from './state.ts';
export type { PanelState, TimelineItem } from './state.ts';
export {
  groupRedactionsByKind,
  groupRedactionsBySource,
  endToEndMs,
  latencyBars,
  privacyWarnings,
  receiptAnalysisLines,
  finalAgentLine,
  receiptNetworkLines,
  formatReceipt,
} from './selectors.ts';
export type { KindRow, LatencyBar, ReceiptLine } from './selectors.ts';
export { App } from './components/App.tsx';
export type { AppProps } from './components/App.tsx';
