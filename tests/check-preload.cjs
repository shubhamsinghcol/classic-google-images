const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const code=fs.readFileSync('js/modern.js','utf8');
const created=[];
class Image {constructor(){created.push(this);} removeAttribute(){this.cancelled=true;} decode(){return Promise.resolve();}}
const context={Image,Map,Set,Math,clearInterval,originalSources:new Map([['thumb4','https://original.example/4.jpg']]),thumbnailKey:x=>x};
vm.createContext(context);
vm.runInContext(code.slice(code.indexOf('  const MIN_SIZE'),code.indexOf('  const DEFAULT_SETTINGS'))+'\nthis.select=(index)=>{items=Array.from({length:10},(_,i)=>({src:`https://image.example/${i}.jpg`,thumb:`thumb${i}`}));activeIndex=index;preloadNeighbors();};this.cache=preloadedImages;this.interval=NAVIGATION_INTERVAL_MS;',context);
context.select(2);assert.equal(context.interval,250);assert.equal(context.cache.size,6);
assert(context.cache.has('https://original.example/4.jpg'));
assert(context.cache.has('https://image.example/6.jpg'));
const firstCreated=created.length;context.select(3);assert.equal(created.length,firstCreated+1);assert(created[0].cancelled);
context.select(9);assert.equal(context.cache.size,2);assert(context.cache.has('https://image.example/9.jpg'));assert(!context.cache.has('https://image.example/0.jpg'));
console.log('Passed: 250ms timing; four originals ahead; previous-image buffer; rolling cache reuse/eviction; no wrap at final image.');
