const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const code = fs.readFileSync('js/modern.js', 'utf8');
let handler, moved = 0, stopped = 0;
const resizeEdge = {};
const context = {panel:{classList:{contains:()=>true}}, resizeEdge, viewer:{querySelector:()=>null}, window:{addEventListener:(_,fn)=>handler=fn}, stopArrowNavigation(){stopped++;}, move(){moved++;}, heldArrow:null, setInterval:()=>1, NAVIGATION_INTERVAL_MS:250};
vm.createContext(context);
vm.runInContext(code.slice(code.indexOf("    window.addEventListener('keydown', event =>"), code.indexOf("    window.addEventListener('keyup', event =>")),context);
function key(target, extra={}) { let prevented=false; handler({key:'ArrowLeft',composedPath:()=>[target],preventDefault(){prevented=true;},stopImmediatePropagation(){},...extra}); return prevented; }
for(const target of [{tagName:'INPUT'}, {tagName:'TEXTAREA'}, {isContentEditable:true}, {getAttribute:()=> 'searchbox'}, {getAttribute:()=> 'combobox'}]) assert.equal(key(target),false);
for(const modifier of ['metaKey','ctrlKey','altKey','shiftKey','isComposing']) assert.equal(key({}, {[modifier]:true}),false);
assert.equal(moved,0); assert.equal(stopped,10);
assert.equal(key({}),true); assert.equal(moved,1);
assert.equal(key(resizeEdge),false);
console.log('Passed: editing fields, editable content, search roles, composition and modified arrows retain keys; plain arrows still navigate.');
