const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('js/modern.js', 'utf8');
const workerSource = fs.readFileSync('js/clipboard-worker.js', 'utf8');
const workerListeners = [];
function dispatch(listeners, message) {
  return new Promise((resolve, reject) => {
    try {
      let handled = false;
      for (const listener of listeners) if (listener(message, {}, resolve) === true) handled = true;
      if (!handled) reject(new Error('No receiver: '+message.type));
    } catch (error) { reject(error); }
  });
}
let writes = 0, failClipboard = false, failFetch = false;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const worker = {URL, Uint8Array, String, btoa, AbortSignal,
  fetch: async () => failFetch ? new Response('Blocked', {status:403}) : new Response(png, {headers:{'content-type':'image/png'}}),
  chrome:{runtime:{onMessage:{addListener:fn=>workerListeners.push(fn)}}}};
let decoded;
const content = {Blob, Uint8Array, atob, console:{error(){}}, setTimeout(){},
  copyFeedback(){},
  chrome:{runtime:{sendMessage:m=>dispatch(workerListeners,m)}},
  createImageBitmap:async blob=>{decoded=await blob.arrayBuffer();return {width:1,height:1,close(){}};},
  OffscreenCanvas:class{getContext(){return {drawImage(){}};}async convertToBlob(){return new Blob([decoded], {type:'image/png'});}},
  ClipboardItem:class{constructor(data){this.data=data;}},
  navigator:{clipboard:{write:async items=>{if(failClipboard)throw Error('Clipboard denied'); assert.equal(items[0].data['image/png'].type,'image/png');writes++;}}}};
vm.createContext(worker); vm.runInContext(workerSource,worker);
let click;
const button={disabled:false};
content.viewer={querySelector:s=>s==='.gir-photo img'?{src:'https://example.com/image.png'}:{addEventListener:(type,fn)=>{click=fn;}}};
vm.createContext(content);
vm.runInContext(source.slice(source.indexOf('  async function prepareClipboardImage'),source.indexOf('  function ensurePanel'))+source.slice(source.indexOf("    viewer.querySelector('.gir-copy-image').addEventListener"),source.indexOf("    window.addEventListener('keydown'")),content);
(async()=>{
  await click({currentTarget:button});assert.equal(writes,1);assert.equal(button.disabled,false);
  failClipboard=true;await click({currentTarget:button});assert.match(button.title,/Clipboard denied/);assert.equal(button.disabled,false);
  failClipboard=false;failFetch=true;await click({currentTarget:button});assert.match(button.title,/403/);assert.equal(writes,1);
  console.log('Passed: copy click fetches and converts PNG, writes the clipboard, reports fetch/write failures, and re-enables the button.');

  let pressed='false', focused=0, closed=0, pagehide;
  const controls={setAttribute:(key,value)=>{if(key==='aria-pressed')pressed=value;}};
  const image={src:'https://example.com/diagram.png',alt:'Study diagram'};
  const children=[];
  const pip={closed:false,document:{head:{append(){}},body:{append:(...nodes)=>children.push(...nodes)},createElement:tag=>({tag,addEventListener(type,fn){this[type]=fn;}})},
    addEventListener:(type,fn)=>{if(type==='pagehide')pagehide=fn;},close(){this.closed=true;closed++;pagehide?.();}};
  const context={console,viewer:{querySelector:s=>s==='.gir-float'?controls:image},window:{focus(){focused++;},documentPictureInPicture:{requestWindow:async()=>{pip.closed=false;return pip;}}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  let floatingWindow'),source.indexOf('  function ensurePanel()'))+'this.toggle=toggleFloatingImage;',context);
  await context.toggle(); assert.equal(pressed,'true');assert.equal(children[0].src,image.src);assert.equal(children.length,1);assert.equal(pip.document.title,'');
  pip.close();assert.equal(closed,1);assert.equal(pressed,'false');
  await context.toggle();await context.toggle();assert.equal(closed,2);assert.equal(pressed,'false');
  context.window.documentPictureInPicture.requestWindow=async()=>{throw Error('No activation');};context.console={error(){}};
  await context.toggle();assert.match(controls.title,/No activation/);assert.equal(pressed,'false');
  console.log('Passed: floating image retains selected source; browser close and toolbar toggle reset it; no overlay button or custom title; pagehide resets state; API errors are handled.');

})().catch(error=>{console.error(error);process.exitCode=1;});
