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
  const DEFAULT_SETTINGS = { theme: 'dark', upscalePercent: 100, layout: 'default', defaultLayout: 'vertical' };
  let settings = { ...DEFAULT_SETTINGS };
  let activeDimensions = null;

  function loadSettings() {
    try {
      chrome.storage.sync.get({ ...DEFAULT_SETTINGS, defaultLayout: null }, values => {
        if (chrome.runtime.lastError) return;
        settings = { ...DEFAULT_SETTINGS, ...values, defaultLayout: values.defaultLayout || (['horizontal', 'vertical'].includes(values.layout) ? values.layout : 'vertical') };
        applySettings();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.defaultLayout) settings.defaultLayout = changes.defaultLayout.newValue || 'vertical';
        if (changes.layout) settings.layout = changes.layout.newValue || DEFAULT_SETTINGS.layout;
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
    applyLayout();
    fitPreviewImage();
  }
  loadSettings();

  function selectOrientation(mode, defaultOrientation, width, height) {
    if (mode === 'horizontal' || mode === 'vertical') return mode;
    const fallback = defaultOrientation === 'horizontal' ? 'horizontal' : 'vertical';
    if (mode !== 'automatic' || !(width > 0 && height > 0)) return fallback;
    if (height >= width * 1.4) return 'vertical';
    if (width >= height * 1.4) return 'horizontal';
    return fallback;
  }

  function currentLayout() {
    return selectOrientation(settings.layout, settings.defaultLayout, activeDimensions?.width, activeDimensions?.height);
  }

  function verticalWidthLimit() {
    return Math.floor(window.innerWidth * 0.75);
  }

  function applyLayout() {
    if (!viewer) return;
    const vertical = currentLayout() === 'vertical';
    const changed = panel.classList.contains('gir-vertical') !== vertical;
    panel.classList.toggle('gir-vertical', vertical);
    const info = viewer.querySelector('.gir-info');
    const photo = viewer.querySelector('.gir-photo');
    const controls = viewer.querySelector('.gir-controls');
    const actions = viewer.querySelector('.gir-actions');
    const title = viewer.querySelector('h2');
    const url = viewer.querySelector('.gir-host');
    const stack = viewer.querySelector('.gir-stack');
    const thumbnails = viewer.querySelector('.gir-thumbnails');
    const copyUrl = viewer.querySelector('.gir-copy-url');
    const copyImage = viewer.querySelector('.gir-copy-image');
    photo.style.removeProperty('height');
    if (vertical) {
      controls.append(copyImage, copyUrl);
      stack.append(controls, photo, title, url, thumbnails);
    }
    else {
      panel.shadowRoot.insertBefore(photo, info);
      actions.append(copyUrl, copyImage);
      info.prepend(controls, title, url, actions, thumbnails);
    }
    if (changed) {
      panel.style.removeProperty('height');
      panel.style.removeProperty('width');
    }
    const edge = viewer.querySelector('.gir-resize-edge');
    edge.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
    edge.setAttribute('aria-valuemin', String(vertical ? Math.min(320, verticalWidthLimit()) : Math.min(340, Math.round(window.innerHeight * 0.42))));
    edge.setAttribute('aria-valuemax', String(vertical ? verticalWidthLimit() : Math.round(window.innerHeight * 0.88)));
    updateCollageSpace();
    scheduleHalo();
  }

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
    const nativePreview = new URL('/imgres', location.origin);
    nativePreview.searchParams.set('imgurl', source || thumbnail);
    nativePreview.searchParams.set('imgrefurl', page || '');
    nativePreview.searchParams.set('q', new URL(location.href).searchParams.get('q') || '');
    return { image, anchor, nativePreview: url?.origin === location.origin && url.pathname === '/imgres' ? url.href : nativePreview.href, src: source || thumbnail, thumb: thumbnail,
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
      :host{box-sizing:border-box;position:fixed;left:12px;right:12px;bottom:12px;width:auto;height:60vh;background:var(--gir-bg,#202124);color:var(--gir-fg,#eee);display:none;z-index:2147483647;font:13px Arial,sans-serif;overflow:hidden;box-shadow:0 4px 24px #0009}
      :host(.gir-open){display:flex}
      .gir-resize-edge{position:absolute;top:0;left:0;right:0;z-index:2;height:14px;cursor:ns-resize;touch-action:none;display:flex;justify-content:flex-end;align-items:flex-start;background:transparent}
      .gir-resize-edge:after{content:"";display:block;width:44px;height:4px;margin:4px 178px 0 0;border-radius:4px;background:#686b70}
      .gir-resize-edge:hover:after,.gir-resize-edge:focus:after{background:#bdc1c6}
      .gir-photo{height:100%;flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:0;box-sizing:border-box;position:relative}
      .gir-photo img{display:block;flex:none;width:auto;height:auto;max-width:none;max-height:none;object-fit:contain;opacity:1;transition:opacity .12s ease-out}
      .gir-info{width:400px;flex:none;position:relative;padding:18px 8px 8px 16px;box-sizing:border-box;overflow-y:auto}
      .gir-info h2{font-size:26px;font-weight:400;line-height:1.35;margin:0 0 6px}
      .gir-title{font-size:26px;font-weight:400;color:var(--gir-fg,#eee);text-decoration:none}
      .gir-title:hover,.gir-host:hover{text-decoration:underline}
      .gir-host{display:block;font-size:17px;line-height:1.35;color:var(--gir-secondary,#c4c7c5);margin:0 0 12px;overflow-wrap:anywhere;text-decoration:none}
      .gir-actions{display:flex;justify-content:center;gap:6px;flex-wrap:wrap}
      .gir-copy-label{display:inline}
      .gir-actions svg{display:none}
      .gir-actions button{color:var(--gir-button-text,#f1f3f4);background:var(--gir-button,#3c4043);border:0;border-radius:22px;padding:10px 12px;cursor:pointer;font:600 17px Arial,sans-serif}
      .gir-actions button:hover{background:var(--gir-button-hover,#4b4f52)}
      .gir-controls{display:flex;justify-content:center;gap:6px;margin:6px 0 14px}
      .gir-controls button{width:48px;height:44px;border:0;border-radius:22px;background:var(--gir-button,#3c4043);color:var(--gir-button-text,#f1f3f4);font:600 26px Arial,sans-serif;line-height:1;cursor:pointer}
      .gir-controls button:hover:not(:disabled){background:var(--gir-button-hover,#4b4f52)}
      .gir-controls button:disabled{opacity:.38;cursor:default}
      .gir-thumbnails{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:14px}
      .gir-thumbnail{display:block;min-width:0;aspect-ratio:1;border:1px solid #ffffff30;border-radius:4px;padding:0;overflow:hidden;background:#0002;cursor:pointer}
      .gir-thumbnail:hover,.gir-thumbnail:focus-visible{outline:2px solid var(--gir-fg,#eee);outline-offset:1px}
      .gir-thumbnail img{display:block;width:100%;height:100%;object-fit:cover}
      .gir-controls svg{width:23px;height:23px;fill:currentColor;vertical-align:middle}
      .gir-native-save{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;background:var(--gir-bg,#202124)}
      .gir-native-save>button{align-self:flex-start;margin:8px;padding:8px 14px;border:0;border-radius:20px;background:var(--gir-button,#3c4043);color:var(--gir-fg,#eee);cursor:pointer}
      .gir-native-save iframe{width:100%;flex:1;min-height:0;border:0;background:white}
      .gir-stack{display:none}
      :host(.gir-vertical){left:auto;top:12px;right:12px;bottom:12px;width:clamp(320px,42vw,560px);max-width:var(--gir-max-width,75vw);height:auto!important;border-radius:12px}
      :host(.gir-vertical) .gir-info{display:none}
      :host(.gir-vertical) .gir-stack{display:block;width:100%;height:100%;overflow-y:auto;scrollbar-color:var(--gir-secondary,#c4c7c5) var(--gir-bg,#202124);box-sizing:border-box;padding:0 14px 18px}
      :host(.gir-vertical) .gir-controls{position:sticky;top:0;z-index:1;background:var(--gir-bg,#202124);margin:0 -4px;padding:12px 0;gap:4px;justify-content:space-between;flex-wrap:wrap}
      :host(.gir-vertical) .gir-photo{width:100%;height:calc(100vh -150px);min-height:180px;flex:none}
      :host(.gir-vertical) .gir-controls button{flex:none;width:38px;height:40px;font-size:24px}
      :host(.gir-vertical) .gir-copy-label{display:none}
      :host(.gir-vertical) .gir-actions{display:none}
      :host(.gir-vertical) h2{font-size:26px;font-weight:400;line-height:1.35;margin:0 0 8px;overflow-wrap:anywhere}
      :host(.gir-vertical) .gir-host{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;overflow-wrap:normal}
      :host(.gir-vertical) .gir-resize-edge{top:0;bottom:0;left:0;right:auto;width:10px;height:auto;cursor:ew-resize}
      :host(.gir-vertical) .gir-resize-edge:after{width:4px;height:44px;margin:auto 0 auto 3px}
      @media(max-width:780px){:host{left:6px;right:6px;bottom:6px;height:60vh}.gir-info{width:240px;padding:18px 6px 6px 12px}.gir-resize-edge:after{margin-right:98px}.gir-info h2,.gir-title{font-size:21px}.gir-host{font-size:15px}.gir-actions button{font-size:15px;padding:8px 10px}.gir-controls button{width:38px;height:42px;font-size:23px}}
    </style><div class="gir-resize-edge" role="separator" aria-orientation="horizontal" aria-label="Resize preview panel" tabindex="0" title="Drag to resize; double-click to reset"></div><div class="gir-photo"><img alt=""></div><aside class="gir-info"><div class="gir-controls" aria-label="Preview controls"><button class="gir-close" type="button" aria-label="Close preview" title="Close">×</button><button class="gir-prev" type="button" aria-label="Previous image" title="Previous">←</button><button class="gir-next" type="button" aria-label="Next image" title="Next">→</button><button class="gir-save" type="button" aria-label="Save photo" title="Save photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm0 15-5-2.2L7 18V5h10z"/></svg></button><button class="gir-lens" type="button" aria-label="Search with Google Lens" title="Search with Google Lens"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H5a2 2 0 0 0-2 2v2h2V5h2zm10 0v2h2v2h2V5a2 2 0 0 0-2-2zM5 17H3v2a2 2 0 0 0 2 2h2v-2H5zm14 0v2h-2v2h2a2 2 0 0 0 2-2v-2zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg></button></div><h2><a class="gir-title" target="_blank" rel="noopener"></a></h2><a class="gir-host" target="_blank" rel="noopener"></a><div class="gir-actions"><button class="gir-copy-url" type="button" aria-label="Copy photo URL" title="Copy photo URL"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1.8 1.8m1.5 4.2a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1.8-1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="gir-copy-label">Copy photo URL</span></button><button class="gir-copy-image" type="button" aria-label="Copy image" title="Copy image"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M9 3h6v4H9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span class="gir-copy-label">Copy image</span></button></div><div class="gir-thumbnails" aria-label="Previous and next images"></div></aside><div class="gir-stack"></div>`;
    viewer.querySelector('.gir-close').addEventListener('click', close);
    viewer.querySelector('.gir-prev').addEventListener('click', () => move(-1));
    viewer.querySelector('.gir-next').addEventListener('click', () => move(1));
    const resizeEdge = viewer.querySelector('.gir-resize-edge');
    let dragStartY = 0;
    let dragStartX = 0;
    let dragStartWidth = 0;
    let dragStartHeight = 0;
    const resizeTo = height => {
      const minimum = Math.min(340, Math.round(window.innerHeight * 0.42));
      const maximum = Math.max(minimum, Math.round(window.innerHeight * 0.88));
      const nextHeight = Math.max(minimum, Math.min(maximum, height));
      panel.style.height = `${nextHeight}px`;
      resizeEdge.setAttribute('aria-valuenow', String(Math.round(nextHeight)));
      fitPreviewImage();
      updateCollageSpace();
    };
    const resetHeight = () => {
      panel.style.removeProperty('height');
      panel.style.removeProperty('width');
      resizeEdge.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().height)));
      fitPreviewImage();
      updateCollageSpace();
    };
    resizeEdge.setAttribute('aria-valuemin', String(Math.min(340, Math.round(window.innerHeight * 0.42))));
    resizeEdge.setAttribute('aria-valuemax', String(Math.round(window.innerHeight * 0.88)));
    resizeEdge.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().height)));
    resizeEdge.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragStartY = event.clientY;
      dragStartX = event.clientX;
      dragStartWidth = panel.getBoundingClientRect().width;
      dragStartHeight = panel.getBoundingClientRect().height;
      resizeEdge.setPointerCapture(event.pointerId);
    });
    resizeEdge.addEventListener('pointermove', event => {
      if (!resizeEdge.hasPointerCapture(event.pointerId)) return;
      if (currentLayout() === 'vertical') {
        panel.style.width = `${Math.max(Math.min(320, verticalWidthLimit()), Math.min(verticalWidthLimit(), dragStartWidth + dragStartX - event.clientX))}px`;
        resizeEdge.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
        fitPreviewImage();
        updateCollageSpace();
      } else resizeTo(dragStartHeight + dragStartY - event.clientY);
    });
    resizeEdge.addEventListener('dblclick', event => {
      event.preventDefault();
      resetHeight();
    });
    resizeEdge.addEventListener('keydown', event => {
      if (currentLayout() === 'vertical' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        panel.style.width = `${Math.max(Math.min(320, verticalWidthLimit()), Math.min(verticalWidthLimit(), panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24)))}px`;
        fitPreviewImage();
        updateCollageSpace();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        resizeTo(panel.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 24 : -24));
      } else if (event.key === 'Home') {
        event.preventDefault();
        resetHeight();
      }
    });
    viewer.querySelector('.gir-save').addEventListener('click', openNativeSave);
    viewer.querySelector('.gir-lens').addEventListener('click', () => {
      const imageUrl = viewer.querySelector('.gir-photo img').src;
      window.open(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`, '_blank', 'noopener,noreferrer');
    });
    viewer.querySelector('.gir-copy-url').addEventListener('click', async event => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(viewer.querySelector('.gir-photo img').src);
        copyFeedback(button, 'Copied URL');
        setTimeout(() => { copyFeedback(button, 'Copy photo URL'); }, 1400);
      } catch { copyFeedback(button, 'Copy failed'); setTimeout(() => { copyFeedback(button, 'Copy photo URL'); }, 1400); }
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
        copyFeedback(button, 'Copied image');
        setTimeout(() => { copyFeedback(button, 'Copy image'); }, 1400);
      } catch (error) {
        console.error('Classic Google Images: Copy image failed', error);
        button.title = error.message || 'Unable to copy this image.';
        copyFeedback(button, 'Copy failed');
        setTimeout(() => { copyFeedback(button, 'Copy image'); }, 1400);
      }
    });
    window.addEventListener('keydown', event => {
      if (!panel.classList.contains('gir-open')) return;
      if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (event.composedPath().includes(resizeEdge)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape' && viewer.querySelector('.gir-native-save')) viewer.querySelector('.gir-native-save').remove();
      else if (viewer.querySelector('.gir-native-save')) return;
      else if (event.key === 'Escape') close();
      else {
        if (event.repeat || heldArrow === event.key) return;
        stopArrowNavigation();
        heldArrow = event.key;
        const delta = event.key === 'ArrowLeft' ? -1 : 1;
        move(delta, true);
        navigationTimer = setInterval(() => move(delta, true), NAVIGATION_INTERVAL_MS);
      }
    }, true);
    window.addEventListener('keyup', event => {
      if (event.key === heldArrow) stopArrowNavigation();
    }, true);
    window.addEventListener('blur', stopArrowNavigation);
    window.addEventListener('resize', () => { fitPreviewImage(); updateCollageSpace(); scheduleHalo(); });
    window.addEventListener('scroll', scheduleHalo, { capture: true, passive: true });
    new ResizeObserver(() => { fitPreviewImage(); updateCollageSpace(); scheduleHalo(); }).observe(panel);
    applySettings();
    return panel;
  }

  function copyFeedback(button, label) {
    button.querySelector('.gir-copy-label').textContent = label;
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function openNativeSave() {
    const item = items[activeIndex];
    if (!item) return;
    viewer.querySelector('.gir-native-save')?.remove();
    const sheet = document.createElement('div');
    sheet.className = 'gir-native-save';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Save to Google collection');
    const back = document.createElement('button');
    back.textContent = 'Back to preview';
    back.addEventListener('click', () => { sheet.remove(); viewer.querySelector('.gir-save').focus(); });
    const frame = document.createElement('iframe');
    frame.title = 'Google image collections';
    frame.src = item.nativePreview;
    // Keep Google's own authenticated Save control and collection picker intact.
    // The frame remains visible for sign-in, choosing a collection, and feedback.
    frame.addEventListener('load', () => {
      try {
        const buttons = [...frame.contentDocument.querySelectorAll('button, [role="button"]')];
        const save = buttons.find(button => /^Save(?: |$)/.test(button.getAttribute('aria-label') || '') || button.textContent.trim() === 'Save');
        save?.click();
      } catch { /* Google's native controls remain available in the frame. */ }
    }, { once: true });
    sheet.append(back, frame);
    viewer.append(sheet);
    back.focus();
  }

  function fitPreviewImage() {
    const image = viewer?.querySelector('.gir-photo img');
    const frame = viewer?.querySelector('.gir-photo');
    if (!image?.naturalWidth || !image.naturalHeight || !frame?.clientWidth || !frame.clientHeight) return;
    const vertical = currentLayout() === 'vertical';
    const scale = Math.min(
      frame.clientWidth / image.naturalWidth,
      (vertical ? Math.max(180, window.innerHeight - 150) : frame.clientHeight) / image.naturalHeight,
      1 + Math.max(0, Number(settings.upscalePercent) || 0) / 100 // 0% disables enlargement; 100% means 2x original size.
    );
    if (vertical) frame.style.height = `${Math.round(image.naturalHeight * scale)}px`;
    image.style.width = `${Math.round(image.naturalWidth * scale)}px`;
    image.style.height = `${Math.round(image.naturalHeight * scale)}px`;
  }

  function placePanel(image) {
    const root = ensurePanel();
    // Keep the viewer outside Google's results DOM. Inserting even one block into
    // the live masonry grid makes Google recalculate columns and lose tiles.
    if (root.parentElement !== document.documentElement) document.documentElement.append(root);
  }

  let collageHalo = null;
  let collageSpace = null;
  let haloFrame = null;

  function activeCollageImage() {
    const item = items[activeIndex];
    if (!item) return null;
    const matches = image => image.isConnected &&
      (thumbnailKey(image.currentSrc || image.src) || image.currentSrc || image.src) === (thumbnailKey(item.thumb) || item.thumb);
    // Google may recycle result nodes after scrolling. Match the captured
    // thumbnail before drawing a halo around a live node.
    if (matches(item.image)) return item.image;
    return [...document.images].find(image => matches(image) && !panel?.contains(image)) || null;
  }

  let collageTarget = null;
  let collageLayoutStyle = null;
  let collageStyleObserver = null;

  function responsiveCollageRules(styleSheets) {
    const output = [];
    function walk(rules, conditions = []) {
      for (const rule of rules) {
        if (!rule.selectorText && rule.cssRules) {
          // Google's masonry rules use viewport breakpoints. Reapply those
          // same tile spans and row sizes against the remaining collage width.
          const condition = rule.conditionText;
          if (condition && !/^(?:[\s(),:.\dpx-]|min-width|max-width|and)+$/.test(condition)) continue;
          walk(rule.cssRules, condition ? [...conditions, condition] : conditions);
        } else if (rule.selectorText?.includes('[data-snc=') && conditions.length) {
          const declarations = [...rule.style].map(property =>
            `${property}:${rule.style.getPropertyValue(property).replace(/vw\b/g, 'cqw')}!important;`).join('');
          const selectors = rule.selectorText.split(',').map(selector => `[data-gir-collage] ${selector}`).join(',');
          let variants = [''];
          for (const condition of conditions) variants = variants.flatMap(prefix => condition.split(',').map(part => prefix ? `${prefix} and ${part.trim()}` : part.trim()));
          for (const condition of variants) output.push(`@container gir-collage ${condition}{${selectors}{${declarations}}}`);
        }
      }
    }
    for (const sheet of styleSheets) {
      if (sheet.ownerNode === collageLayoutStyle) continue;
      try { walk(sheet.cssRules); } catch { /* Ignore cross-origin sheets. */ }
    }
    return output.join('\n');
  }

  function restoreCollageLayout() {
    collageTarget?.removeAttribute('data-gir-collage');
    collageTarget?.style.removeProperty('--gir-collage-width');
    collageTarget = null;
    collageStyleObserver?.disconnect();
    collageStyleObserver = null;
    collageLayoutStyle?.remove();
    collageLayoutStyle = null;
  }

  function updateCollageLayout() {
    if (!panel?.classList.contains('gir-open') || currentLayout() !== 'vertical') {
      restoreCollageLayout();
      return;
    }
    if (!collageTarget?.isConnected) {
      const image = activeCollageImage();
      collageTarget = document.querySelector('#center_col') || document.querySelector('#search') || image?.closest('[role="main"], main, .grid');
      if (!collageTarget) return;
      collageTarget.setAttribute('data-gir-collage', '');
    }
    if (!collageLayoutStyle) {
      collageLayoutStyle = document.createElement('style');
      const rebuild = () => {
        collageLayoutStyle.textContent = '[data-gir-collage]{box-sizing:border-box!important;width:var(--gir-collage-width)!important;max-width:var(--gir-collage-width)!important;min-width:0!important;container-type:inline-size;container-name:gir-collage;}' + responsiveCollageRules(document.styleSheets) + '[data-gir-collage] [data-snc]{min-width:0!important;}';
      };
      document.head.append(collageLayoutStyle);
      rebuild();
      collageStyleObserver = new MutationObserver(records => {
        if (records.some(record => [...record.addedNodes].some(node => node !== collageLayoutStyle && (node.nodeName === 'STYLE' || node.querySelector?.('style'))))) rebuild();
      });
      collageStyleObserver.observe(document.documentElement, {childList:true, subtree:true});
    }
    const available = Math.max(0, panel.getBoundingClientRect().left - collageTarget.getBoundingClientRect().left - 12);
    collageTarget.style.setProperty('--gir-collage-width', `${available}px`);
    scheduleHalo();
  }

  function updateCollageSpace() {
    if (panel) panel.style.setProperty('--gir-max-width', `${verticalWidthLimit()}px`);
    updateCollageLayout();
    if (!panel?.classList.contains('gir-open')) return;
    if (currentLayout() === 'vertical') { collageSpace?.remove(); collageSpace = null; return; }
    if (!collageSpace) {
      collageSpace = document.createElement('div');
      collageSpace.setAttribute('aria-hidden', 'true');
      collageSpace.style.cssText = 'display:block;pointer-events:none;width:1px;flex:none;';
      document.body.append(collageSpace);
    }
    // Allow even the last result row to scroll above the floating preview.
    collageSpace.style.height = `${window.innerHeight - panel.getBoundingClientRect().top + 24}px`;
  }

  function scheduleHalo() {
    if (haloFrame !== null) return;
    haloFrame = requestAnimationFrame(() => {
      haloFrame = null;
      paintCollageHalo();
    });
  }

  function collageVisibleTop() {
    let bottom = 0;
    // Measure Google's live header rows: their height changes with wrapping,
    // viewport size, and the sticky search/category bars used while scrolling.
    for (const row of document.querySelectorAll('#searchform, #hdtb, #appbar, .UpCcGe, header, [role="navigation"], [role="search"]')) {
      const rect = row.getBoundingClientRect();
      if (rect.width >= window.innerWidth * 0.4 && rect.top < window.innerHeight && rect.bottom > 0) {
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    return bottom;
  }

  function paintCollageHalo() {
    const image = panel?.classList.contains('gir-open') && activeCollageImage();
    if (!image) {
      if (collageHalo) collageHalo.style.display = 'none';
      return;
    }
    if (!collageHalo) {
      collageHalo = document.createElement('div');
      collageHalo.setAttribute('aria-hidden', 'true');
      collageHalo.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border:3px solid #ff5252;border-radius:8px;box-shadow:0 0 0 4px #ff303055,0 0 22px 8px #ff303099;';
      document.documentElement.append(collageHalo);
    }
    const box = image.getBoundingClientRect();
    Object.assign(collageHalo.style, {
      display: box.width && box.height ? 'block' : 'none',
      left: `${box.left - 3}px`, top: `${box.top - 3}px`,
      width: `${box.width + 6}px`, height: `${box.height + 6}px`,
      // Include the glow in the clipping bounds so it cannot paint over the
      // search/category bars or the preview, even during manual scrolling.
      clipPath: `inset(${Math.max(-40, collageVisibleTop() - box.top + 3)}px -40px ${Math.max(-40, box.bottom + 3 - (panel.classList.contains('gir-vertical') ? window.innerHeight : panel.getBoundingClientRect().top))}px -40px)`
    });
  }

  function revealCollageImage() {
    const image = activeCollageImage();
    if (!image) return;
    const box = image.getBoundingClientRect();
    const visibleBottom = (panel.classList.contains('gir-vertical') ? window.innerHeight : panel.getBoundingClientRect().top) - 16;
    const visibleTop = collageVisibleTop() + 16;
    if (box.top >= visibleTop && box.bottom <= visibleBottom) return;
    const targetTop = visibleTop + Math.max(0, (visibleBottom - visibleTop - box.height) / 2);
    window.scrollBy({ top: box.top - targetTop,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  function show(index, reveal = false) {
    if (!items.length) return;
    activeIndex = Math.max(0, Math.min(items.length - 1, index));
    const item = items[activeIndex];
    refreshOriginalSources();
    const original = originalSources.get(thumbnailKey(item.thumb));
    if (original) item.src = original;
    const cached = preloadedImages.get(item.src);
    // Use decoded originals when available; retain the previous orientation
    // during a pending load instead of briefly switching through the default.
    activeDimensions = item.dimensions || (cached?.naturalWidth && cached.naturalHeight ? { width: cached.naturalWidth, height: cached.naturalHeight } : activeDimensions);
    placePanel(item.image);
    const root = ensurePanel();
    setDetails(item);
    applyLayout();
    fitPreviewImage();
    viewer.querySelector('.gir-prev').disabled = activeIndex === 0;
    viewer.querySelector('.gir-next').disabled = activeIndex === items.length - 1;
    renderThumbnails();
    root.classList.add('gir-open');
    updateCollageSpace();
    paintCollageHalo();
    if (reveal) revealCollageImage();
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
      item.dimensions = { width: full.naturalWidth, height: full.naturalHeight };
      activeDimensions = item.dimensions;
      const previousLayout = panel.classList.contains('gir-vertical');
      applyLayout();
      fitPreviewImage();
      if (panel.classList.contains('gir-open') && previousLayout !== panel.classList.contains('gir-vertical')) revealCollageImage();
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
      button.addEventListener('click', () => show(index, true));
      strip.append(button);
    }
  }

  function move(delta, reveal = true) {
    // Keep the clicked page's result sequence fixed while previewing. Re-scanning
    // Google's changing lazy-loaded DOM here can reorder or duplicate results.
    const nextIndex = activeIndex + delta;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    show(nextIndex, reveal);
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
    activeDimensions = null;
    viewer.querySelector('.gir-native-save')?.remove();
    panel.classList.remove('gir-open');
    restoreCollageLayout();
    collageSpace?.remove();
    collageSpace = null;
    paintCollageHalo();
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
