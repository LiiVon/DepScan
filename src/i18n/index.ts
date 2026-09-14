import type { Strings } from './types';
import { zh } from './zh';
import { en } from './en';

export type UiLanguage = 'auto' | 'zh' | 'en';
export type ResolvedLanguage = 'zh' | 'en';

let current: Strings = zh;
let currentTag: ResolvedLanguage = 'zh';

/**
 * 解析实际生效的语言。
 *
 * - `zh` / `en`：显式指定，直接生效
 * - `auto`：跟随 VS Code 显示语言 —— `zh*` 用中文，其余用英文
 *
 * 这里用 `vscode.env.language`（扩展宿主直接给出，如 "zh-cn" / "en"），
 * 而不是嗅探 `VSCODE_NLS_CONFIG` 的 JSON 文本 —— 后者一旦格式化带空格
 * （`"locale": "en"`）就会漏判，英文环境下会错误地显示中文。
 */
export function resolveLanguage(configured: UiLanguage, vscodeLanguage: string): ResolvedLanguage {
  if (configured === 'zh' || configured === 'en') return configured;
  return vscodeLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 初始化（配置变更时可重复调用） */
export function initI18n(configured: UiLanguage, vscodeLanguage: string): ResolvedLanguage {
  const lang = resolveLanguage(configured, vscodeLanguage);
  current = lang === 'en' ? en : zh;
  currentTag = lang;
  return lang;
}

/** 当前生效的文案表 */
export function s(): Strings {
  return current;
}

/** 当前生效语言 */
export function currentLanguage(): ResolvedLanguage {
  return currentTag;
}

/** BCP-47 标记，用于 <html lang> */
export function currentLanguageTag(): string {
  return currentTag === 'en' ? 'en' : 'zh-CN';
}

/** 语言自身的显示名（中文/英文各自书写，便于辨认） */
export function languageLabel(lang: UiLanguage): string {
  const t = current;
  if (lang === 'auto') return t.actions.languageAuto;
  if (lang === 'en') return t.actions.languageEn;
  return t.actions.languageZh;
}
