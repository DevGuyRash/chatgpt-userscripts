// Network helpers using GM_xmlhttpRequest when available.
export function request(opts: { method?: string; url: string; headers?: Record<string,string>; body?: any; }) {
  return new Promise<{ status: number; responseText: string; headers: string }>((resolve, reject) => {
    const method = (opts.method || 'GET').toUpperCase();
    const hasGM = typeof (globalThis as any).GM_xmlhttpRequest === 'function' || (globalThis as any).GM?.xmlHttpRequest;
    if (hasGM) {
      const fn = (globalThis as any).GM_xmlhttpRequest || (globalThis as any).GM.xmlHttpRequest;
      fn({
        method,
        url: opts.url,
        headers: opts.headers || {},
        data: opts.body,
        onload: (res: any) => resolve({ status: res.status, responseText: res.responseText, headers: res.responseHeaders }),
        onerror: (err: any) => reject(err),
      });
      return;
    }
    // Fallback fetch (might be CORS-limited)
    fetch(opts.url, { method, headers: opts.headers, body: opts.body })
      .then(async (r) => resolve({ status: r.status, responseText: await r.text(), headers: '' }))
      .catch(reject);
  });
}

export async function getJSON<T=unknown>(url: string, headers: Record<string,string> = {}) {
  const res = await request({ url, headers });
  return JSON.parse(res.responseText) as T;
}
