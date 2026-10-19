// Provide a global declaration so TS knows GMU exists in the userscript sandbox.
declare global {
  const GMU: {
    dom: typeof import('../lib/dom');
    net: typeof import('../lib/net');
    storage: typeof import('../lib/storage');
  };
}
export {};
