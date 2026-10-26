declare const __VERSION__: string;
/** 建置時注入；開發模式沒有就顯示 dev */
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
