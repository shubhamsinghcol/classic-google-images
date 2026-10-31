const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('js/modern.js', 'utf8');
const helpers = source.slice(source.indexOf('  // Session storage stays'), source.indexOf("  applySettings();\n  window.addEventListener('pagehide'"));
const close = source.slice(source.indexOf('  function close(forget'), source.indexOf('  // Session storage stays'));
const store = new Map();
function start(href) {
  let results = [], observer, shown = [], timer;
  const context = {URL, Number, JSON, panel:null,items:[], location:{href,origin:'https://www.google.com'},
    sessionStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
    document:{body:{},createElement:()=>({})},
    MutationObserver:class{constructor(fn){this.run=fn;observer=this;}observe(){}disconnect(){this.disconnected=true;}},
    setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{timer=null;},
    collectItems:()=>results,thumbnailKey:value=>{try{return new URL(value).searchParams.get('q');}catch{return null;}},
    isGoogleThumbnail:value=>value.includes('encrypted-tbn'),
    show(index,reveal,restoring){shown.push({index,item:context.items[index],restoring});context.remember(context.items[index]);}
  };
  vm.createContext(context);vm.runInContext(close+helpers+'this.restore=restorePreview;this.remember=rememberPreview;this.read=readPreview;this.key=previewStorageKey;this.cancel=cancelPreviewRestore;this.closePreview=close;',context);
  return {context,results:value=>{results=value;},shown,observer:()=>observer,timer:()=>timer};
}
const pageA='https://www.google.com/search?q=diagram&udm=2';
const pageB='https://www.google.com/search?q=anatomy&udm=2';
const itemA={src:'https://images.example/diagram.jpg',thumb:'https://encrypted-tbn0.gstatic.com/images?q=diagram',page:'https://example.com/diagram',title:'Diagram',nativePreview:'https://www.google.com/imgres?imgurl=https://images.example/diagram.jpg',dimensions:{width:1600,height:1200}};
const itemB={...itemA,src:'https://images.example/anatomy.jpg',thumb:'https://encrypted-tbn0.gstatic.com/images?q=anatomy',title:'Anatomy'};
let run=start(pageA);run.context.remember(itemA);
// A fresh document with the same session store represents a refresh.
run=start(pageA);run.results([itemB,itemA]);run.context.restore();assert.equal(run.shown.at(-1).index,1);assert.equal(run.shown.at(-1).item.title,'Diagram');
// Back/Forward returns to the selection saved for that page, without confusing queries.
run.context.location.href=pageB;run.context.restore();assert.equal(run.shown.length,1);run.context.remember(itemB);run.results([itemB]);run.context.restore();assert.equal(run.shown.at(-1).item.title,'Anatomy');
run.context.location.href=pageA+'#ip=1';run.results([itemA]);run.context.restore();assert.equal(run.shown.at(-1).item.title,'Diagram');
// When Google is still loading the grid, show the saved picture immediately.
run=start(pageA);run.context.restore();assert.equal(run.shown.at(-1).item.src,itemA.src);assert(run.observer());assert(run.timer());
const thumbnailOnly={...itemA,src:itemA.thumb};run.results([itemB,thumbnailOnly]);run.observer().run();assert.equal(run.shown.at(-1).index,1);assert.equal(run.shown.at(-1).item.src,itemA.src);assert(run.observer().disconnected);assert.equal(run.timer(),null);
run.context.closePreview();assert.equal(store.has(run.context.key()),false);
run=start(pageA);run.context.restore();assert.equal(run.shown.length,0);
// Saved page data is untrusted; never load script URLs or a foreign Save iframe.
store.set(run.context.key(),'{broken');assert.equal(run.context.read(run.context.key()),null);
store.set(run.context.key(),JSON.stringify({...itemA,src:'javascript:alert(1)'}));assert.equal(run.context.read(run.context.key()),null);
store.set(run.context.key(),JSON.stringify({...itemA,nativePreview:'https://evil.example/imgres'}));assert.equal(run.context.read(run.context.key()),null);
console.log('Passed: refresh restoration, query-specific Back/Forward state, hash stability, immediate saved-image restore, delayed tile matching, original-source retention, close clearing, and malformed-state rejection.');
