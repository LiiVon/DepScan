import type { Strings } from './types';
import { zh } from './zh';
import { en } from './en';

export type UiLanguage = 'auto' | 'zh' | 'en';

let current: Strings = zh;

/** 依据配置与 VS Code 显示语言决定 UI 语言（默认中文） */
export function initI18n(configured: UiLanguage): UiLanguage {
  let lang: UiLanguage = configured;
  if (lang === 'auto') {
    const vscodeLang = (process.env.VSCODE_NLS_CONFIG ?? '').toLowerCase();
    lang = vscodeLang.includes('"locale":"en') ? 'en' : 'zh';
  }
  current = lang === 'en' ? en : zh;
  return lang;
}

export function s(): Strings {
  return current;
}
