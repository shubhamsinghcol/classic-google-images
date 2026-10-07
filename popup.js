const DEFAULTS = { theme: 'dark', upscalePercent: 100, layout: 'default', defaultLayout: null };
const radios = [...document.querySelectorAll('input[name="scale"]')];
const themeButtons = [...document.querySelectorAll('[data-theme]')];
const customInput = document.querySelector('#custom-value');
const status = document.querySelector('#status');

function setStatus(message) {
  status.textContent = message;
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => { status.textContent = ''; }, 1200);
}

function selected(name) {
  return document.querySelector(`input[name="${name}"]:checked`);
}

function restore(values) {
  setThemeSelection(values.theme);
  const defaultLayout = values.defaultLayout || (['horizontal', 'vertical'].includes(values.layout) ? values.layout : 'vertical');
  document.querySelector(`input[name="default-layout"][value="${defaultLayout === 'horizontal' ? 'horizontal' : 'vertical'}"]`).checked = true;
  const mode = ['horizontal', 'vertical', 'automatic'].includes(values.layout) ? values.layout : defaultLayout;
  document.querySelector(`input[name="layout"][value="${mode === 'horizontal' || mode === 'automatic' ? mode : 'vertical'}"]`).checked = true;
  const scale = Number(values.upscalePercent);
  const preset = document.querySelector(`input[name="scale"][value="${scale}"]`);
  if (preset) preset.checked = true;
  else {
    document.querySelector('input[name="scale"][value="custom"]').checked = true;
    customInput.value = String(scale);
  }
}

function setThemeSelection(theme) {
  themeButtons.forEach(button => {
    const selected = button.dataset.theme === theme;
    button.setAttribute('aria-pressed', String(selected));
  });
}

chrome.storage.sync.get(DEFAULTS, restore);

radios.forEach(radio => radio.addEventListener('change', () => {
  if (radio.value !== 'custom') {
    chrome.storage.sync.set({ upscalePercent: Number(radio.value) }, () => setStatus('Enlargement limit saved'));
  }
}));

themeButtons.forEach(button => button.addEventListener('click', () => {
  setThemeSelection(button.dataset.theme);
  chrome.storage.sync.set({ theme: button.dataset.theme }, () => setStatus('Theme saved'));
}));

customInput.addEventListener('focus', () => {
  document.querySelector('input[name="scale"][value="custom"]').checked = true;
});
customInput.addEventListener('input', () => {
  document.querySelector('input[name="scale"][value="custom"]').checked = true;
  const value = Number(customInput.value);
  if (customInput.value === '' || !Number.isFinite(value) || value < 0 || value > 1000) {
    customInput.setCustomValidity('Enter a value from 0 to 1000 percent.');
    return;
  }
  customInput.setCustomValidity('');
  chrome.storage.sync.set({ upscalePercent: value }, () => setStatus('Custom enlargement limit saved'));
});

document.querySelectorAll('input[name="layout"]').forEach(radio => radio.addEventListener('change', () => {
  chrome.storage.sync.set({ layout: radio.value, defaultLayout: selected('default-layout')?.value || 'vertical' }, () => setStatus('Preview layout saved'));
}));

document.querySelectorAll('input[name="default-layout"]').forEach(radio => radio.addEventListener('change', () => {
  const mode = selected('layout')?.value || 'vertical';
  chrome.storage.sync.set({ defaultLayout: radio.value, layout: mode }, () => setStatus('Default orientation saved'));
}));
