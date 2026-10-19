// Minimal typings so TypeScript is happy. Non-exhaustive.
declare function GM_addStyle(css: string): void;
declare function GM_setValue<T = unknown>(key: string, value: T): void;
declare function GM_getValue<T = unknown>(key: string, defaultValue?: T): T;
declare function GM_xmlhttpRequest(opts: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: any;
  onload?: (res: { status: number; responseText: string; responseHeaders: string }) => void;
  onerror?: (err: any) => void;
}): void;

declare const GM: {
  xmlHttpRequest?: typeof GM_xmlhttpRequest;
};
