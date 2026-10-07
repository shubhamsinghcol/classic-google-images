const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('js/modern.js','utf8');
class Node {
  constructor(name) { this.name=name; this.children=[]; this.style={removeProperty(){}}; }
  detach(node) { if(node.parent) node.parent.children=node.parent.children.filter(x=>x!==node); }
  append(...nodes) { for(const node of nodes){this.detach(node);node.parent=this;this.children.push(node);} }
  prepend(...nodes) { for(const node of nodes)this.detach(node); for(const node of nodes)node.parent=this;this.children.unshift(...nodes); }
  insertBefore(node,before) {this.detach(node);node.parent=this;this.children.splice(this.children.indexOf(before),0,node);}
  setAttribute(key,value) {this[key]=value;}
}
const root=new Node('root'),info=new Node('info'),photo=new Node('photo'),controls=new Node('controls'),actions=new Node('actions'),title=new Node('title'),url=new Node('url'),stack=new Node('stack'),edge=new Node('edge'),thumbnails=new Node('thumbnails'),copyUrl=new Node('copyUrl'),copyImage=new Node('copyImage');
root.append(photo,info,stack);info.append(controls,title,url,actions,thumbnails);actions.append(copyUrl,copyImage);
const mapping={'.gir-info':info,'.gir-photo':photo,'.gir-controls':controls,'.gir-actions':actions,'h2':title,'.gir-host':url,'.gir-stack':stack,'.gir-resize-edge':edge,'.gir-thumbnails':thumbnails,'.gir-copy-url':copyUrl,'.gir-copy-image':copyImage};
const classes=new Set(); const image={naturalWidth:1000,naturalHeight:700,style:{}};
photo.clientWidth=532;photo.clientHeight=697;
const context={viewer:{querySelector:s=>s==='.gir-photo img'?image:mapping[s]},panel:{shadowRoot:root,style:{removeProperty(){}},classList:{contains:c=>classes.has(c),toggle:(c,v)=>v?classes.add(c):classes.delete(c)}},currentLayout:()=>context.settings.layout,settings:{layout:'vertical',upscalePercent:100},window:{innerHeight:847,innerWidth:1440},updateCollageSpace(){},scheduleHalo(){}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function verticalWidthLimit()'),source.indexOf('  function cleanGoogleMarkup'))+source.slice(source.indexOf('  function fitPreviewImage()'),source.indexOf('  function placePanel('))+'\nthis.layout=applyLayout;this.fit=fitPreviewImage;',context);
context.layout();assert.deepEqual(stack.children.map(x=>x.name),['controls','photo','title','url','thumbnails']);assert.equal(edge['aria-orientation'],'vertical');assert.deepEqual(controls.children.map(x=>x.name),['copyImage','copyUrl']);
context.fit();assert.equal(image.style.width,'532px');assert.equal(photo.style.height,'372px');
image.naturalWidth=700;image.naturalHeight=2000;context.fit();assert.equal(image.style.height,'697px');
context.settings.layout='horizontal';context.layout();assert.deepEqual(info.children.map(x=>x.name),['controls','title','url','actions','thumbnails']);assert.equal(photo.parent,root);assert.equal(edge['aria-orientation'],'horizontal');assert.deepEqual(actions.children.map(x=>x.name),['copyUrl','copyImage']);
const popup=fs.readFileSync('popup.js','utf8');assert(popup.includes("querySelectorAll('input[name=\"scale\"]')"));assert(popup.includes("chrome.storage.sync.set({ layout: radio.value, defaultLayout:"));
console.log('Passed: vertical order; horizontal restoration preserves nodes; landscape fills width; portrait fits height; layout storage is separate from enlargement.');
let nativeClicks=0;
const nativeSave={getAttribute:()=> 'Save the selected image',textContent:'Save',click(){nativeClicks++;}};
const made=[];
const saveContext={items:[{nativePreview:'https://www.google.com/imgres?imgurl=selected-image'}],activeIndex:0,viewer:{querySelector:()=>null,append(){}},document:{createElement:tag=>{const node={tag,textContent:'',setAttribute(){},focus(){},append(){},addEventListener(type,fn){this[type]=fn;},contentDocument:{querySelectorAll:()=>[nativeSave]}};made.push(node);return node;}}};
vm.createContext(saveContext);
vm.runInContext(source.slice(source.indexOf('  function openNativeSave()'),source.indexOf('  function fitPreviewImage()'))+'\nthis.save=openNativeSave;',saveContext);
saveContext.save();const frame=made.find(n=>n.tag==='iframe');assert.equal(frame.src,saveContext.items[0].nativePreview);frame.load();assert.equal(nativeClicks,1);
nativeSave.getAttribute=()=> 'Saved the selected image';nativeSave.textContent='Saved';frame.load();assert.equal(nativeClicks,1);
console.log('Passed: Save targets the captured Google result and does not toggle an already saved image.');
