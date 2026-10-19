// Storage helpers wrapping GM_getValue/GM_setValue with localStorage fallback
function hasGM() {
  return typeof (globalThis as any).GM_getValue === 'function' && typeof (globalThis as any).GM_setValue === 'function';
}

export function get<T=unknown>(key: string, defaultValue: T): T {
  if (hasGM()) {
    try {
      return (globalThis as any).GM_getValue(key, defaultValue);
    } catch {}
  }
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? defaultValue : JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

export function set<T=unknown>(key: string, value: T) {
  if (hasGM()) {
    try { (globalThis as any).GM_setValue(key, value); return; } catch {}
  }
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
