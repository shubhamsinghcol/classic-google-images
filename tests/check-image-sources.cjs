const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = '';
const source = fs.readFileSync(root + 'js/modern.js', 'utf8');
const helpers = source.slice(source.indexOf('  function cleanGoogleMarkup'), source.indexOf('  function looksLikeImageUrl'));
const records = [
 ['fnatic-a', 'https://cf-img.fnatic.com/cdn-cgi/image/width=1200/https://cdn.sanity.io/a.jpg',617,1200],
 ['fnatic-b', 'https://cdn.sanity.io/b.jpg',8192,8192],
 ['x-profile', 'https://pbs.twimg.com/profile_images/profile.jpg',400,400],
 ['x-media', 'https://pbs.twimg.com/media/photo?format=webp&name=large',1936,1070]
];
const script = {textContent:records.map(([key,url,h,w])=>JSON.stringify([0,key,[`https://encrypted-tbn0.gstatic.com/images?q=tbn:${key}&s=10`,100,100],[url,h,w],{page:'shared-publisher-page'}])).join(',').replaceAll('&','\\u0026').replaceAll('=','\\u003d')};
const context = {URL,document:{scripts:[script]}};
vm.createContext(context);
vm.runInContext(helpers + '\nthis.refresh=refreshOriginalSources;this.sources=originalSources;this.key=thumbnailKey;',context);
context.refresh();
for(const [key,url] of records) assert.equal(context.sources.get(`tbn:${key}`),url);
assert.equal(context.key('https://encrypted-tbn0.gstatic.com/images?q=tbn:x-media&s=200'), 'tbn:x-media');
assert.equal(context.sources.has('shared-publisher-page'),false);
script.textContent += ','+JSON.stringify([['https://encrypted-tbn0.gstatic.com/images?q=tbn:x-media',100,100],['https://wrong.example/other.jpg',400,400]]);
context.refresh();
assert.equal(context.sources.get('tbn:x-media'),null);
assert(!source.includes('findPageImage'));
const worker = fs.readFileSync(root+'js/clipboard-worker.js','utf8');
assert(!worker.includes('og:image'));
assert(!worker.includes('gir-find-page-image'));
assert.equal(JSON.parse(fs.readFileSync(root+'manifest.json')).version,'2.1.0');
console.log('Passed: same-page images stay distinct; X media stays distinct from profile; escaped URLs decode; ambiguous pairs rejected; webpage substitution removed; version 2.1.0.');
