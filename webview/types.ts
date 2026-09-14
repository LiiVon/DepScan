// Webview ⇄ 扩展宿主 的消息协议（双向）
import type { Direction } from '../src/engine/protocol';
import type { GraphData, ScanStats } from '../src/graph/model';

export interface UiSettings {
  depth: number;
  direction: Direction;
  showExternal: boolean;
  cluster: boolean;
  clickToOpen: boolean;
  focusId: string;
  label: string;
  language: 'auto' | 'zh' | 'en';
  stats?: ScanStats;
}

export type HostToWebview =
  | { type: 'render'; graph: GraphData; settings: UiSettings; truncated: boolean; totalAvailable?: number }
  | { type: 'merge'; graph: GraphData; settings: UiSettings }
  | { type: 'select'; id: string }
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string }
  | { type: 'toast'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'open'; id: string; file: string; line: number; column: number }
  | { type: 'expand'; id: string; depth: number; direction: Direction }
  | { type: 'reload'; depth: number; direction: Direction; showExternal: boolean }
  | { type: 'setLanguage'; language: 'auto' | 'zh' | 'en' }
  | { type: 'architecture' }
  | { type: 'exportImage'; format: 'png' | 'svg'; data: string; suggestedName: string }
  | { type: 'exportData'; format: 'json' | 'dot' | 'mermaid' }
  | { type: 'log'; message: string };

/** 泳道图页面 → 宿主（页面里的脚本只做缩放 / 导出 / 点击，不负责绘制） */
export type SwimlaneToHost =
  | { type: 'ready' }
  | { type: 'open'; file: string; line: number; column: number }
  | { type: 'export' }
  | { type: 'refresh' };

/** 宿主 → 泳道图页面：只送「画什么」，页面自己决定缩放 */
export type SwimlaneToWebview =
  | { type: 'svg'; svg: string; title: string; status: string; notice?: string }
  | { type: 'empty'; message: string; title: string };
