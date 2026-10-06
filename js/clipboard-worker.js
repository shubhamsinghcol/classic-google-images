chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'gir-fetch-image') return;

  (async () => {
    const imageUrl = new URL(message.url);
    if (!['http:', 'https:'].includes(imageUrl.protocol)) throw new Error('Only HTTP and HTTPS image URLs can be copied.');
    const response = await fetch(imageUrl.href, { credentials: 'omit' });
    if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
    const blob = await response.blob();
    if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') {
      throw new Error('The selected address did not return an image.');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error('The image response was empty.');
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    }
    sendResponse({ ok: true, base64: btoa(chunks.join('')), contentType: blob.type });
  })().catch(error => {
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});
