// DOM helpers
export function $(selector: string, root: ParentNode = document) {
  return root.querySelector(selector) as HTMLElement | null;
}
export function $all(selector: string, root: ParentNode = document) {
  return Array.from(root.querySelectorAll(selector)) as HTMLElement[];
}

export function on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Document, type: K, handler: (ev: any) => void) {
  el.addEventListener(type, handler as any, false);
  return () => el.removeEventListener(type, handler as any, false);
}

export function addStyle(css: string) {
  if (typeof (globalThis as any).GM_addStyle === 'function') {
    (globalThis as any).GM_addStyle(css);
  } else {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
}

export async function waitForSelector(selector: string, { timeout = 10000, interval = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const el = $(selector);
    if (el) return el;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitForSelector timeout: ${selector}`);
}
