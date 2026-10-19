// Example userscript entry using the shared GMU library.
// The GMU global is provided by the @require of dist/lib/gmu.js in the wrapper.
(async () => {
  const { dom, storage, net } = GMU;

  dom.addStyle(`
    .gmu-banner { position: fixed; bottom: 1rem; right: 1rem; padding: .5rem 1rem; background: #222; color: #fff; border-radius: 6px; font: 12px/1.4 system-ui, sans-serif; z-index: 999999; }
  `);

  // Use storage
  const count = storage.get('example:visits', 0) + 1;
  storage.set('example:visits', count);

  // Maybe fetch something (will use GM_xmlhttpRequest if granted)
  try {
    const todo = await net.getJSON('https://jsonplaceholder.typicode.com/todos/1');
    console.log('Fetched example JSON:', todo);
  } catch (e) {
    console.warn('Fetch failed (likely CORS if GM_xmlhttpRequest not granted).', e);
  }

  const banner = document.createElement('div');
  banner.className = 'gmu-banner';
  banner.textContent = `GMU example loaded – visits: ${count}`;
  document.body.appendChild(banner);

  // tiny demo
  const h1 = await dom.waitForSelector('h1').catch(() => null);
  if (h1) h1.style.outline = '2px dashed #8a2be2';
})();
