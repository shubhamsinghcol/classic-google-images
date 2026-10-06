(() => {
  if (window.__girClassicInstalled) return;
  window.__girClassicInstalled = true;
  const MIN_SIZE = 72;
  let panel = null;
  let viewer = null;
  let activeIndex = -1;
  let items = [];
  let imageRequest = 0;
  const NAVIGATION_INTERVAL_MS = 250;
  const PRELOAD_AHEAD = 4;
  const preloadedImages = new Map();
  let navigationTimer = null;
  let heldArrow = null;

  function stopArrowNavigation() {
    clearInterval(navigationTimer);
    navigationTimer = null;
    heldArrow = null;
  }

  function preloadNeighbors() {
    const wanted = new Set();
    for (let index = Math.max(0, activeIndex - 1); index <= Math.min(items.length - 1, activeIndex + PRELOAD_AHEAD); index++) {
      const item = items[index];
      const original = originalSources.get(thumbnailKey(item.thumb));
      if (original) item.src = original;
      wanted.add(item.src);
      if (preloadedImages.has(item.src)) continue;
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => { image.decode?.().catch(() => {}); };
      preloadedImages.set(item.src, image);
      image.src = item.src;
    }
    for (const [url, image] of preloadedImages) {
      if (wanted.has(url)) continue;
      image.onload = null;
      image.removeAttribute('src');
      preloadedImages.delete(url);
    }
  }
  const DEFAULT_SETTINGS = { theme: 'dark', upscalePercent: 100 };
  let settings = { ...DEFAULT_SETTINGS };

  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULT_SETTINGS, values => {
        if (chrome.runtime.lastError) return;
        settings = { ...DEFAULT_SETTINGS, ...values };
        applySettings();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.theme) settings.theme = changes.theme.newValue || DEFAULT_SETTINGS.theme;
        if (changes.upscalePercent) settings.upscalePercent = changes.upscalePercent.newValue ?? DEFAULT_SETTINGS.upscalePercent;
        applySettings();
      });
    } catch { /* Keep defaults when run outside an extension context. */ }
  }

  function applySettings() {
    if (!viewer) return;
    const palettes = {
      dark: ['#202124', '#eee', '#3c4043', '#f1f3f4', '#4b4f52', '#c4c7c5'],
      light: ['#fff', '#202124', '#e8eaed', '#202124', '#dadce0', '#5f6368'],
      sepia: ['#f4ecd8', '#433728', '#e6d8ba', '#433728', '#d9c9a8', '#68563e']
    };
    const [background, foreground, button, buttonText, hover, secondary] = palettes[settings.theme] || palettes.dark;
    const host = viewer.host;
    host.style.setProperty('--gir-bg', background);
    host.style.setProperty('--gir-fg', foreground);
    host.style.setProperty('--gir-button', button);
    host.style.setProperty('--gir-button-text', buttonText);
    host.style.setProperty('--gir-button-hover', hover);
    host.style.setProperty('--gir-secondary', secondary);
    fitPreviewImage();
  }
  loadSettings();

  function cleanGoogleMarkup(value) {
    return String(value || '').replace(/&amp;/g, '&').replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&')
      .replace(/\\u003a/gi, ':').replace(/\\\//g, '/').replace(/&quot;/g, '"');
  }

  function isGoogleThumbnail(value) {
    try { return /^encrypted-tbn\d*\.gstatic\.com$/i.test(new URL(value).hostname); }
    catch { return false; }
  }

  const originalSources = new Map();
  const scannedScripts = new WeakMap();

  function thumbnailKey(value) {
    try {
      const url = new URL(value);
      return isGoogleThumbnail(url.href) ? url.searchParams.get('q') : null;
    } catch { return null; }
  }

  function refreshOriginalSources() {
    // Google serializes each result as adjacent [thumbnail, height, width] and
    // [original, height, width] tuples. Parse those exact pairs as JSON data;
    // never infer an image from its publisher URL or surrounding text.
    const string = '"(?:\\\\.|[^"\\\\])*"';
    const tuple = `\\[${string}\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*\\]`;
    const pair = new RegExp(`(${tuple})\\s*,\\s*(${tuple})`, 'g');
    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (scannedScripts.get(script) === text) continue;
      scannedScripts.set(script, text);
      if (!text.includes('encrypted-tbn')) continue;
      pair.lastIndex = 0;
      for (const match of text.matchAll(pair)) {
        try {
          const thumbnail = JSON.parse(match[1]);
          const original = JSON.parse(match[2]);
          const key = thumbnailKey(thumbnail[0]);
          const url = new URL(original[0]);
          if (!key || !/^https?:$/.test(url.protocol) || isGoogleThumbnail(url.href)
              || original[1] <= 0 || original[2] <= 0) continue;
          // Ambiguous records must retain their own thumbnail, never guess.
          if (originalSources.has(key) && originalSources.get(key) !== url.href) {
            originalSources.set(key, null);
          } else if (!originalSources.has(key)) originalSources.set(key, url.href);
        } catch { /* Skip malformed tuples without executing page scripts. */ }
      }
    }
  }

  function looksLikeImageUrl(value) {
    try { return /\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?)(?:$|[/?#])/i.test(new URL(value).pathname); }
    catch { return false; }
  }

  function getImageSource(image) {
    const original = originalSources.get(thumbnailKey(image.currentSrc || image.src));
    if (original) return original;
    const candidates = [];
    const add = (raw, score, explicitImageUrl = false) => {
      if (!raw) return;
      const value = cleanGoogleMarkup(raw).trim().replace(/[),;]+$/, '');
      const addUrl = (candidate, candidateScore) => {
        try {
          const url = new URL(candidate, location.href);
          if (!/^https?:$/.test(url.protocol) || isGoogleThumbnail(url.href)) return;
          if (!explicitImageUrl && !looksLikeImageUrl(url.href)) return;
          candidates.push({ url: url.href, score: candidateScore });
        } catch { /* Ignore non-URL metadata. */ }
      };
      try {
        const parsed = new URL(value, location.href);
        for (const key of ['imgurl', 'mediaurl', 'ou', 'fullsize', 'original']) {
          const nested = parsed.searchParams.get(key);
          if (nested) addUrl(nested, score + 30, true);
        }
        if (/^https?:$/.test(parsed.protocol) && !/google\.[^/]+$/i.test(parsed.hostname)) addUrl(parsed.href, score, explicitImageUrl);
      } catch { /* Parse any embedded URL strings below. */ }
      for (const match of value.matchAll(/https?:\\?\/\\?\/[^\s"'<>\\]+/g)) addUrl(match[0].replace(/\\\//g, '/'), score - 5, false);
    };

    const preferredAttributes = ['data-iurl', 'data-fullsize', 'data-full-url', 'data-original', 'data-ou', 'data-imgurl', 'data-mediaurl'];
    for (const name of preferredAttributes) add(image.getAttribute(name), 120);
    for (const [name, value] of Object.entries(image.dataset || {})) {
      if (/^(?:src|url|fullsize|original|mediaurl|imgurl)$/i.test(name)) add(value, 75, true);
    }

    for (let node = image.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
      const links = [...(node.matches?.('a[href]') ? [node] : []), ...node.querySelectorAll('a[href]')];
      const nearbyImages = [...node.querySelectorAll('img')].filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
      });
      // A sibling link is safe to associate only when this container has one
      // visible result image. Larger ancestor containers often span several
      // Google tiles; reading links there can pair this tile with its neighbor.
      const isSingleImageTile = nearbyImages.length === 1 && nearbyImages[0] === image;
      for (const link of links) {
        const relatedToImage = link.contains(image);
        if (!relatedToImage && !isSingleImageTile) continue;
        try {
          const href = new URL(link.href, location.href);
          for (const key of ['imgurl', 'mediaurl', 'ou', 'fullsize', 'original']) {
            const value = href.searchParams.get(key);
            if (value) add(value, (relatedToImage ? 135 : 90) - depth, true);
          }
        } catch { /* Ignore malformed links. */ }
        add(link.dataset.iurl, 115 - depth, true);
        add(link.dataset.fullsize || link.dataset.ou, 110 - depth, true);
        add(link.dataset.imgurl || link.dataset.mediaurl, 110 - depth, true);
      }
      for (const name of preferredAttributes) {
        const elements = node.querySelectorAll(`[${name}]`);
        for (const element of elements) {
          if (element === image || element.contains(image) || image.contains(element)) add(element.getAttribute(name), 105 - depth, true);
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.url || '';
  }

  function getItem(image) {
    const nearbyAnchor = image.closest('a[href]');
    const source = getImageSource(image);
    const anchor = nearbyAnchor;
    const url = anchor?.href ? new URL(anchor.href, location.href) : null;
    const title = image.alt || anchor?.getAttribute('aria-label') || anchor?.innerText?.trim().split('\n')[0] || 'Image';
    let page = url?.searchParams.get('imgrefurl') || '';
    if (!page) {
      for (let node = image.parentElement, depth = 0; node && node !== document.body && depth < 8 && !page; node = node.parentElement, depth++) {
        const tileImages = [...node.querySelectorAll('img')].filter(img => {
          const rect = img.getBoundingClientRect();
          return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
        });
        if (tileImages.length !== 1 || tileImages[0] !== image) continue;
        for (const link of node.querySelectorAll('a[href]')) {
          try {
            const href = new URL(link.href, location.href);
            if (href.searchParams.has('imgrefurl')) {
              page = href.searchParams.get('imgrefurl');
              break;
            }
            if (href.hostname !== location.hostname && /^https?:$/.test(href.protocol)) {
              page = href.href;
              break;
            }
          } catch { /* Ignore malformed links. */ }
        }
      }
    }
    const thumbnail = image.currentSrc || image.src;
    return { image, anchor, src: source || thumbnail, thumb: thumbnail,
      page: page || (url && url.origin !== location.origin ? url.href : ''), title };
  }

  function collectItems() {
    refreshOriginalSources();
    return [...document.images].filter(image => {
      if (panel?.contains(image) || !image.alt) return false;
      const box = image.getBoundingClientRect();
      return box.width >= MIN_SIZE && box.height >= MIN_SIZE;
    }).map(getItem).filter(item => item.src && !item.src.startsWith('data:'));
  }

  async function prepareClipboardImage(imageUrl) {
    const result = await chrome.runtime.sendMessage({ type: 'gir-fetch-image', url: imageUrl });
    if (!result?.ok) throw new Error(result?.error || 'Unable to fetch this image.');
    if (typeof result.base64 !== 'string') throw new Error('Image bytes were not received. Reload the extension and refresh this tab.');
    // Chrome extension messages use JSON by default: ArrayBuffer is lost in
    // transit. Base64 survives that boundary; reconstruct the actual bytes.
    const binary = atob(result.base64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const source = new Blob([bytes], { type: result.contentType });
    const bitmap = await createImageBitmap(source);
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
      }
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image conversion failed.')), 'image/png'));
    } finally { bitmap.close(); }
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'gir-classic-viewer';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Google Images preview');
    viewer = panel.attachShadow({ mode: 'open' });
    viewer.innerHTML = `<style>
      :host{box-sizing:border-box;position:fixed;left:12px;right:12px;bottom:12px;width:auto;height:70vh;background:var(--gir-bg,#202124);color:var(--gir-fg,#eee);display:none;z-index:2147483647;font:13px Arial,sans-serif;overflow:hidden;box-shadow:0 4px 24px #0009}
      :host(.gir-open){display:flex}
      .gir-resize-edge{position:sticky;top:-8px;z-index:2;height:14px;cursor:ns-resize;touch-action:none;display:flex;justify-content:center;align-items:flex-start;margin:-8px -8px 4px -16px;background:var(--gir-bg,#202124)}
      .gir-resize-edge:after{content:"";display:block;width:44px;height:4px;margin-top:4px;border-radius:4px;background:#686b70}
      .gir-resize-edge:hover:after,.gir-resize-edge:focus:after{background:#bdc1c6}
      .gir-photo{height:100%;flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:0;box-sizing:border-box;position:relative}
      .gir-photo img{display:block;flex:none;width:auto;height:auto;max-width:none;max-height:none;object-fit:contain;opacity:1;transition:opacity .12s ease-out}
      .gir-info{width:400px;flex:none;position:relative;padding:8px 8px 8px 16px;box-sizing:border-box;overflow-y:auto}
      .gir-info h2{font-size:26px;font-weight:400;line-height:1.35;margin:0 0 6px}
      .gir-title{font-size:26px;font-weight:400;color:var(--gir-fg,#eee);text-decoration:none}
      .gir-title:hover,.gir-host:hover{text-decoration:underline}
      .gir-host{display:block;font-size:17px;line-height:1.35;color:var(--gir-secondary,#c4c7c5);margin:0 0 12px;overflow-wrap:anywhere;text-decoration:none}
      .gir-actions{display:flex;justify-content:center;gap:6px;flex-wrap:wrap}
      .gir-actions button{color:var(--gir-button-text,#f1f3f4);background:var(--gir-button,#3c4043);border:0;border-radius:22px;padding:10px 12px;cursor:pointer;font:600 17px Arial,sans-serif}
      .gir-actions button:hover{background:var(--gir-button-hover,#4b4f52)}
      .gir-controls{display:flex;justify-content:center;gap:10px;margin:6px 0 14px}
      .gir-controls button{width:48px;height:44px;border:0;border-radius:22px;background:var(--gir-button,#3c4043);color:var(--gir-button-text,#f1f3f4);font:600 26px Arial,sans-serif;line-height:1;cursor:pointer}
      .gir-controls button:hover:not(:disabled){background:var(--gir-button-hover,#4b4f52)}
      .gir-controls button:disabled{opacity:.38;cursor:default}
      .gir-thumbnails{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:14px}
      .gir-thumbnail{display:block;min-width:0;aspect-ratio:1;border:1px solid #ffffff30;border-radius:4px;padding:0;overflow:hidden;background:#0002;cursor:pointer}
      .gir-thumbnail:hover,.gir-thumbnail:focus-visible{outline:2px solid var(--gir-fg,#eee);outline-offset:1px}
      .gir-thumbnail img{display:block;width:100%;height:100%;object-fit:cover}
      @media(max-width:780px){:host{left:6px;right:6px;bottom:6px;height:70vh}.gir-info{width:240px;padding:8px 6px 6px 12px}.gir-resize-edge{margin-right:-6px;margin-left:-12px}.gir-info h2,.gir-title{font-size:21px}.gir-host{font-size:15px}.gir-actions button{font-size:15px;padding:8px 10px}.gir-controls button{width:42px;height:42px;font-size:23px}}
    </style><div class="gir-photo"><img alt=""></div><aside class="gir-info"><div class="gir-resize-edge" role="separator" aria-orientation="horizontal" aria-label="Resize preview panel" tabindex="0" title="Drag to resize; double-click to reset"></div><div class="gir-controls" aria-label="Preview controls"><button class="gir-close" type="button" aria-label="Close preview" title="Close">×</button><button class="gir-prev" type="button" aria-label="Previous image" title="Previous">←</button><button class="gir-next" type="button" aria-label="Next image" title="Next">→</button></div><h2><a class="gir-title" target="_blank" rel="noopener"></a></h2><a class="gir-host" target="_blank" rel="noopener"></a><div class="gir-actions"><button class="gir-copy-url" type="button">Copy photo URL</button><button class="gir-copy-image" type="button">Copy image</button></div><div class="gir-thumbnails" aria-label="Previous and next images"></div></aside>`;
    viewer.querySelector('.gir-close').addEventListener('click', close);
    viewer.querySelector('.gir-prev').addEventListener('click', () => move(-1));
    viewer.querySelector('.gir-next').addEventListener('click', () => move(1));
    const resizeEdge = viewer.querySelector('.gir-resize-edge');
    let dragStartY = 0;
    let dragStartHeight = 0;
    const resizeTo = height => {
      const minimum = Math.min(340, Math.round(window.innerHeight * 0.42));
      const maximum = Math.max(minimum, Math.round(window.innerHeight * 0.88));
      const nextHeight = Math.max(minimum, Math.min(maximum, height));
      panel.style.height = `${nextHeight}px`;
      resizeEdge.setAttribute('aria-valuenow', String(Math.round(nextHeight)));
      fitPreviewImage();
    };
    const resetHeight = () => {
      panel.style.removeProperty('height');
      resizeEdge.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().height)));
      fitPreviewImage();
    };
    resizeEdge.setAttribute('aria-valuemin', String(Math.min(340, Math.round(window.innerHeight * 0.42))));
    resizeEdge.setAttribute('aria-valuemax', String(Math.round(window.innerHeight * 0.88)));
    resizeEdge.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().height)));
    resizeEdge.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragStartY = event.clientY;
      dragStartHeight = panel.getBoundingClientRect().height;
      resizeEdge.setPointerCapture(event.pointerId);
    });
    resizeEdge.addEventListener('pointermove', event => {
      if (!resizeEdge.hasPointerCapture(event.pointerId)) return;
      resizeTo(dragStartHeight + dragStartY - event.clientY);
    });
    resizeEdge.addEventListener('dblclick', event => {
      event.preventDefault();
      resetHeight();
    });
    resizeEdge.addEventListener('keydown', event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        resizeTo(panel.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 24 : -24));
      } else if (event.key === 'Home') {
        event.preventDefault();
        resetHeight();
      }
    });
    viewer.querySelector('.gir-copy-url').addEventListener('click', async event => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(viewer.querySelector('.gir-photo img').src);
        button.textContent = 'Copied URL';
        setTimeout(() => { button.textContent = 'Copy photo URL'; }, 1400);
      } catch { button.textContent = 'Copy failed'; setTimeout(() => { button.textContent = 'Copy photo URL'; }, 1400); }
    });
    viewer.querySelector('.gir-copy-image').addEventListener('click', async event => {
      const button = event.currentTarget;
      try {
        const imageUrl = viewer.querySelector('.gir-photo img').src;
        // Start the clipboard write during the click. The PNG promise can finish
        // after the worker fetch without losing the user's clipboard gesture.
        const png = prepareClipboardImage(imageUrl);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        button.title = '';
        button.textContent = 'Copied image';
        setTimeout(() => { button.textContent = 'Copy image'; }, 1400);
      } catch (error) {
        console.error('Classic Google Images: Copy image failed', error);
        button.title = error.message || 'Unable to copy this image.';
        button.textContent = 'Copy failed';
        setTimeout(() => { button.textContent = 'Copy image'; }, 1400);
      }
    });
    window.addEventListener('keydown', event => {
      if (!panel.classList.contains('gir-open')) return;
      if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') close();
      else {
        if (event.repeat || heldArrow === event.key) return;
        stopArrowNavigation();
        heldArrow = event.key;
        const delta = event.key === 'ArrowLeft' ? -1 : 1;
        move(delta);
        navigationTimer = setInterval(() => move(delta), NAVIGATION_INTERVAL_MS);
      }
    }, true);
    window.addEventListener('keyup', event => {
      if (event.key === heldArrow) stopArrowNavigation();
    }, true);
    window.addEventListener('blur', stopArrowNavigation);
    window.addEventListener('resize', fitPreviewImage);
    return panel;
  }

  function fitPreviewImage() {
    const image = viewer?.querySelector('.gir-photo img');
    const frame = viewer?.querySelector('.gir-photo');
    if (!image?.naturalWidth || !image.naturalHeight || !frame?.clientWidth || !frame.clientHeight) return;
    const scale = Math.min(
      frame.clientWidth / image.naturalWidth,
      frame.clientHeight / image.naturalHeight,
      1 + Math.max(0, Number(settings.upscalePercent) || 0) / 100 // 0% disables enlargement; 100% means 2x original size.
    );
    image.style.width = `${Math.round(image.naturalWidth * scale)}px`;
    image.style.height = `${Math.round(image.naturalHeight * scale)}px`;
  }

  function placePanel(image) {
    const root = ensurePanel();
    // Keep the viewer outside Google's results DOM. Inserting even one block into
    // the live masonry grid makes Google recalculate columns and lose tiles.
    if (root.parentElement !== document.documentElement) document.documentElement.append(root);
  }

  function show(index) {
    if (!items.length) return;
    activeIndex = Math.max(0, Math.min(items.length - 1, index));
    const item = items[activeIndex];
    refreshOriginalSources();
    const original = originalSources.get(thumbnailKey(item.thumb));
    if (original) item.src = original;
    placePanel(item.image);
    const root = ensurePanel();
    setDetails(item);
    viewer.querySelector('.gir-prev').disabled = activeIndex === 0;
    viewer.querySelector('.gir-next').disabled = activeIndex === items.length - 1;
    renderThumbnails();
    root.classList.add('gir-open');
    preloadNeighbors();
  }

  function setDetails(item) {
    const request = ++imageRequest;
    // Each selection owns a separate image element and load/error handlers.
    // An earlier network request can never paint into the new selection.
    const full = document.createElement('img');
    viewer.querySelector('.gir-photo img').replaceWith(full);
    full.style.opacity = '0';
    full.style.width = '';
    full.style.height = '';
    let usedThumbnailFallback = false;
    full.onload = () => {
      if (request !== imageRequest) return;
      fitPreviewImage();
      requestAnimationFrame(() => {
        if (request === imageRequest) full.style.opacity = '1';
      });
    };
    full.onerror = () => {
      if (request !== imageRequest) return;
      if (usedThumbnailFallback) {
        full.style.opacity = '1';
        return;
      }
      usedThumbnailFallback = true;
      // Use the thumbnail captured with this result. Google may recycle tile
      // image elements as the page scrolls, so reading the live element here can
      // show another result's thumbnail under the current title.
      const thumbnail = item.thumb;
      if (thumbnail && thumbnail !== item.src) full.src = thumbnail;
      else full.style.opacity = '1';
    };
    full.src = item.src;
    if (full.complete && full.naturalWidth) full.onload();
    full.alt = item.title;
    viewer.querySelector('.gir-title').textContent = item.title;
    const hostLink = viewer.querySelector('.gir-host');
    hostLink.textContent = item.page || item.src;
    hostLink.href = item.page || item.src;
    viewer.querySelector('.gir-title').href = item.page || item.src;
  }

  function renderThumbnails() {
    if (!viewer || activeIndex < 0 || !items.length) return;
    const strip = viewer.querySelector('.gir-thumbnails');
    strip.replaceChildren();
    const neighbors = [activeIndex - 1, activeIndex + 1]
      .filter(index => index >= 0 && index < items.length);
    for (const index of neighbors) {
      const item = items[index];
      // Keep the neighbor preview tied to the source captured for that result;
      // Google can recycle the original DOM image node after scrolling.
      const src = item.thumb || item.src;
      if (!src) continue;
      const button = document.createElement('button');
      button.className = 'gir-thumbnail';
      button.type = 'button';
      button.title = item.title || 'Image preview';
      button.setAttribute('aria-label', item.title || 'Image preview');
      const thumb = document.createElement('img');
      thumb.src = src;
      thumb.alt = '';
      button.append(thumb);
      button.addEventListener('click', () => show(index));
      strip.append(button);
    }
  }

  function move(delta) {
    // Keep the clicked page's result sequence fixed while previewing. Re-scanning
    // Google's changing lazy-loaded DOM here can reorder or duplicate results.
    const nextIndex = activeIndex + delta;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    show(nextIndex);
  }

  function close() {
    if (!panel) return;
    stopArrowNavigation();
    for (const image of preloadedImages.values()) {
      image.onload = null;
      image.removeAttribute('src');
    }
    preloadedImages.clear();
    ++imageRequest;
    panel.classList.remove('gir-open');
    const image = viewer.querySelector('.gir-photo img');
    image.removeAttribute('src');
    image.style.width = '';
    image.style.height = '';
  }

  applySettings();

  document.addEventListener('click', event => {
    if (panel && event.composedPath().includes(panel)) return;
    const path = event.composedPath?.() || [];
    const image = path.find(node => node instanceof HTMLImageElement) || event.target.closest?.('img');
    if (!image) return;
    const box = image.getBoundingClientRect();
    if (box.width < MIN_SIZE || box.height < MIN_SIZE) return;
    refreshOriginalSources();
    const item = getItem(image);
    if (!item) return;
    items = collectItems();
    let index = items.findIndex(entry => entry.image === image);
    if (index < 0) { items.unshift(item); index = 0; }
    else items[index] = item;
    event.preventDefault();
    event.stopImmediatePropagation();
    show(index);
  }, true);
})();
