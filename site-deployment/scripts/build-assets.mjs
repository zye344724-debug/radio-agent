import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root=new URL('../',import.meta.url).pathname, assets=join(root,'assets'), out=join(root,'dist');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.geojson':'application/geo+json; charset=utf-8'};
const entries={};
function collect(dir){for(const name of readdirSync(dir,{withFileTypes:true})){const path=join(dir,name.name);if(name.isDirectory())collect(path);else{const relativePath=relative(assets,path).replaceAll('\\','/');const key=relativePath==='index.html'?'/index.html':'/static/'+relativePath;const ext=key.slice(key.lastIndexOf('.'));entries[key]={body:readFileSync(path,'utf8'),type:types[ext]||'application/octet-stream'};}}}
collect(assets);mkdirSync(join(out,'server'),{recursive:true});mkdirSync(join(out,'.openai'),{recursive:true});
writeFileSync(join(out,'server','index.js'),'const ASSETS = '+JSON.stringify(entries)+';\n'+readFileSync(join(root,'worker','index.js'),'utf8'));
copyFileSync(join(root,'.openai','hosting.json'),join(out,'.openai','hosting.json'));
console.log('Built '+Object.keys(entries).length+' static assets into Worker');
