'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const helpers=[['application-observer','lib/app-observation-macos.jxa'],['recording','native/recording-helper'],['demo-ax','native/demo-ax-helper'],['narration','helpers/narration.mjs']].map(([id,file])=>{
  const p=path.join(root,file),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size===0)throw new Error('Missing ordinary helper: '+file);
  return {id,path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')};
});
// The declarative API is reviewed source. Rebuild only version and exact helper
// pins; this standalone repository does not need access to host implementation.
const value=JSON.parse(fs.readFileSync(path.join(root,'desktop-plugin.json'),'utf8'));
if(value.schema!=='openbot.desktop-plugin/1'||value.id!=='desktop-capture')throw new Error('Unexpected desktop manifest');
value.version=require(path.join(root,'package.json')).version;value.nativeHelpers=helpers;
fs.writeFileSync(path.join(root,'desktop-plugin.json'),JSON.stringify(value,null,2)+'\n');
