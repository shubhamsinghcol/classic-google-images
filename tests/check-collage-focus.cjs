const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('js/modern.js', 'utf8');
let box = {left:30,top:700,bottom:850,width:200,height:150};
const image = {isConnected:true,src:'thumb-a',getBoundingClientRect:()=>box};
const elements = [];
let open = true, scrolled;
const context = {
  items:[{image,thumb:'thumb-a'}],activeIndex:0,thumbnailKey:x=>x,
  panel:{classList:{contains:name=>name === 'gir-open' && open},contains:()=>false,getBoundingClientRect:()=>({top:400})},
  document:{querySelectorAll:()=>[{getBoundingClientRect:()=>({top:0,bottom:120,width:1000})}],images:[image],createElement:()=>({style:{},setAttribute(){}}),documentElement:{append:e=>elements.push(e)}},
  window:{innerWidth:1000,innerHeight:1000,scrollBy:options=>{scrolled=options;},matchMedia:()=>({matches:false})}
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  let collageHalo'),source.indexOf('  function show(index'))+'\nthis.paint=paintCollageHalo;this.reveal=revealCollageImage;this.active=activeCollageImage;',context);
context.paint(); assert.equal(elements[0].style.left,'27px'); assert.equal(elements[0].style.width,'206px');
context.reveal(); assert.equal(scrolled.behavior,'smooth'); assert(scrolled.top>0);
box={...box,top:140,bottom:290}; scrolled=null;context.reveal();assert.equal(scrolled,null);
box={...box,top:80,bottom:230};context.paint();assert.equal(elements[0].style.clipPath,'inset(43px -40px -40px -40px)');
assert.match(elements[0].style.cssText,/#ff5252/);
image.src='recycled-thumb'; context.paint();assert.equal(elements[0].style.display,'none');assert.equal(context.active(),null);
const replacement={...image,src:'thumb-a'};context.document.images.push(replacement);assert.equal(context.active(),replacement);
open=false;context.paint();assert.equal(elements[0].style.display,'none');
console.log('Passed: halo geometry; scroll above preview; visible rows stay still; recycled nodes rejected; matching replacement found; close hides halo; red glow clips below header.');
