// Injected plugin-boundary fixtures only. No App, native recorder, room engine or real capture is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {apply,inputSchema} from '../index.mjs';

const recordingId='a'.repeat(32),hallId='hall_own-1';
// Actual encoded 1x1 PNG bytes, not a screenshot or evidence of recording an App.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=','base64');
const dataUrl='data:image/png;base64,'+png.toString('base64');
const reference={attachmentId:'owned-image-attachment',bytes:png.length,width:1,height:1,mediaType:'image/png'};
function fixture({observe=async()=>({recordingId,dataUrl}),saveImage=async()=>reference,signal=new AbortController().signal}={}) {
 let tool;const calls={observe:[],saveImage:[]};
 const ctx={tools:{register(value){assert.equal(tool,undefined);tool=value;}},desktopCapture:{
  observe:async(...args)=>{calls.observe.push(args);return observe(...args);},
  saveImage:async(...args)=>{calls.saveImage.push(args);return saveImage(...args);}
 }};
 apply(ctx);const exec={signal,agent:{id:'trusted-agent-fixture'},callId:'call-owned'};
 return {tool,calls,exec,run:args=>tool.execute(args,exec)};
}
const invalid=e=>e.code==='INVALID_PARAMS';
test('image fixture encodes an actual one-pixel PNG, not placeholder bytes',()=>{
 assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
 assert.equal(png.readUInt32BE(16),1);assert.equal(png.readUInt32BE(20),1);
 const chunks=[];for(let p=8;p<png.length;){const n=png.readUInt32BE(p);if(png.toString('ascii',p+4,p+8)==='IDAT')chunks.push(png.subarray(p+8,p+8+n));p+=n+12;}
 assert.deepEqual(inflateSync(Buffer.concat(chunks)),Buffer.from([0,255,255,255,255]));
});
test('public schema and description expose the four room actions without caller identity or scope',()=>{
 const f=fixture();assert.equal(f.tool.parameters,inputSchema);assert.equal(inputSchema.additionalProperties,false);
 for(const action of ['list-rooms','record-room','stop-room-recording','read-room-recording']){assert.ok(inputSchema.properties.action.enum.includes(action));assert.ok(f.tool.description.includes(action));}
 assert.equal(inputSchema.properties.durationSeconds.maximum,30);assert.equal(inputSchema.properties.frameIndex.maximum,5);
 assert.equal(inputSchema.properties.hallId.pattern,'^[A-Za-z0-9_-]{1,256}$');
 for(const property of ['botId','viewBotId','scope','roomBinding','memberBotIds'])assert.equal(inputSchema.properties[property],undefined);
});
test('list-rooms forwards only the action with trusted execution context and needs no image',async()=>{
 const value={ok:true,rooms:[{hallId}]},f=fixture({observe:async()=>value});
 assert.deepEqual(await f.run({action:'list-rooms'}),{metadata:value,images:[]});
 assert.deepEqual(f.calls.observe,[[{action:'list-rooms'},{signal:f.exec.signal,agent:f.exec.agent,callId:f.exec.callId}]]);assert.equal(f.calls.saveImage.length,0);
});
test('record-room forwards bounded duration and turns encoded image bytes into an attachment reference',async()=>{
 const f=fixture(),args={action:'record-room',hallId,durationSeconds:30},result=await f.run(args);
 assert.deepEqual(f.calls.observe[0][0],args);assert.deepEqual(f.calls.saveImage[0],[{data:png,mediaType:'image/png',name:'capture.png'},f.exec]);
 assert.deepEqual(result,{metadata:{recordingId},images:[reference]});assert.ok(!JSON.stringify(result).includes('base64'));
 assert.deepEqual(f.tool.output.render(args,result),[{type:'text',text:JSON.stringify({recordingId})},{type:'image',attachment:reference}]);
});
test('stop-room-recording forwards exact hall and recording IDs and permits metadata-only completion',async()=>{
 const value={recordingId,state:'closed'},f=fixture({observe:async()=>value}),args={action:'stop-room-recording',hallId,recordingId};
 assert.deepEqual(await f.run(args),{metadata:value,images:[]});assert.deepEqual(f.calls.observe[0][0],args);assert.equal(f.calls.saveImage.length,0);
});
test('read-room-recording forwards bounded frame index and strips raw frame bytes from metadata',async()=>{
 const f=fixture({observe:async()=>({recordingId,frames:[{index:5,dataUrl}],content:[{type:'image_url',image_url:{url:dataUrl}}]})});
 const args={action:'read-room-recording',hallId,recordingId,frameIndex:5},result=await f.run(args);
 assert.deepEqual(f.calls.observe[0][0],args);assert.equal(f.calls.saveImage.length,1,'Repeated byte URL is saved only once');
 assert.deepEqual(result,{metadata:{recordingId,frames:[{index:5}]},images:[reference]});
});
test('room recording supports default duration and room reads support default frame index',async()=>{
 for(const args of [{action:'record-room',hallId},{action:'record-room',hallId,durationSeconds:1},{action:'read-room-recording',hallId,recordingId},{action:'read-room-recording',hallId,recordingId,frameIndex:0}]){
  const f=fixture();await f.run(args);assert.deepEqual(f.calls.observe[0][0],args);
 }
});
test('caller-forged Bot, view, scope and cross-action fields are rejected before the host',async()=>{
 const bases=[{action:'list-rooms'},{action:'record-room',hallId},{action:'stop-room-recording',hallId,recordingId},{action:'read-room-recording',hallId,recordingId}];
 for(const base of bases)for(const [key,value] of Object.entries({botId:'victim',ownerBotId:'victim',initiatorBotId:'victim',viewBotId:'private',scope:{hallId:'other'},roomBinding:{hallId:'other'},matchId:'forged',memberBotIds:['victim'],authorizationKey:'forged',source:'screen',targetId:'b'.repeat(32),captureId:'c'.repeat(32)})){
  const f=fixture();await assert.rejects(f.run({...base,[key]:value}),invalid);assert.equal(f.calls.observe.length,0);assert.equal(f.calls.saveImage.length,0);
 }
 for(const args of [{action:'list-rooms',hallId},{action:'record-room',hallId,recordingId},{action:'record-room',hallId,frameIndex:0},{action:'stop-room-recording',hallId,recordingId,frameIndex:0},{action:'stop-room-recording',hallId,recordingId,durationSeconds:1},{action:'read-room-recording',hallId,recordingId,durationSeconds:1}]){
  const f=fixture();await assert.rejects(f.run(args),invalid);assert.equal(f.calls.observe.length,0);
 }
});
test('missing, malformed, oversized and non-string room or recording IDs are rejected',async()=>{
 for(const bad of [undefined,null,'','with space','../hall','hall/child','房间','a'.repeat(257),3,[hallId],{id:hallId}])for(const action of ['record-room','stop-room-recording','read-room-recording']){
  const f=fixture();await assert.rejects(f.run({action,hallId:bad,...(action==='record-room'?{}:{recordingId})}),invalid);assert.equal(f.calls.observe.length,0);
 }
 for(const bad of [undefined,null,'',recordingId.slice(1),'A'.repeat(32),'z'.repeat(32),'../'+recordingId,3,[recordingId],{id:recordingId}])for(const action of ['stop-room-recording','read-room-recording']){
  const f=fixture();await assert.rejects(f.run({action,hallId,recordingId:bad}),invalid);assert.equal(f.calls.observe.length,0);
 }
});
test('invalid duration and frame index values fail before host dispatch',async()=>{
 for(const durationSeconds of [null,0,31,-1,1.5,'10',NaN,Infinity]){const f=fixture();await assert.rejects(f.run({action:'record-room',hallId,durationSeconds}),invalid);assert.equal(f.calls.observe.length,0);}
 for(const frameIndex of [null,-1,6,1.5,'0',NaN,Infinity]){const f=fixture();await assert.rejects(f.run({action:'read-room-recording',hallId,recordingId,frameIndex}),invalid);assert.equal(f.calls.observe.length,0);}
});
test('record-room and read-room-recording cannot claim success without image bytes',async()=>{
 for(const action of ['record-room','read-room-recording']){
  const f=fixture({observe:async()=>({recordingId,frames:[]})});
  await assert.rejects(f.run({action,hallId,...(action==='read-room-recording'?{recordingId}:{})}),e=>e.code==='APP_OBSERVATION_EMPTY');assert.equal(f.calls.saveImage.length,0);
 }
});
test('an absent trusted host and malformed host images or attachment references fail closed',async()=>{
 assert.throws(()=>apply({tools:{register(){}}}),e=>e.code==='APP_OBSERVATION_UNAVAILABLE');
 for(const dataUrl of ['https://example.invalid/p.png','data:text/plain;base64,SGk=','data:image/png;base64,!invalid']){
  const f=fixture({observe:async()=>({dataUrl})});await assert.rejects(f.run({action:'record-room',hallId}),e=>e.code==='APP_OBSERVATION_INVALID');assert.equal(f.calls.saveImage.length,0);
 }
 const f=fixture({saveImage:async()=>({attachmentId:'bad',bytes:png.length,width:0,height:1})});
 await assert.rejects(f.run({action:'record-room',hallId}),e=>e.code==='APP_OBSERVATION_INVALID');
});
test('cancellation before or during observation never proceeds to saveImage',async()=>{
 for(const before of [true,false]){
  const c=new AbortController(),reason=new Error('owned cancellation');
  const f=fixture({signal:c.signal,observe:async()=>{c.abort(reason);return {dataUrl};}});if(before)c.abort(reason);
  await assert.rejects(f.run({action:'record-room',hallId}),e=>e===reason);
  assert.equal(f.calls.observe.length,before?0:1);assert.equal(f.calls.saveImage.length,0);
 }
});
test('cancellation during an image save rejects without saving subsequent images',async()=>{
 const c=new AbortController(),reason=new Error('cancel after first attachment');
 const second='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
 const f=fixture({signal:c.signal,observe:async()=>({frames:[{dataUrl},{dataUrl:second}]}),saveImage:async()=>{c.abort(reason);return reference;}});
 await assert.rejects(f.run({action:'read-room-recording',hallId,recordingId}),e=>e===reason);assert.equal(f.calls.saveImage.length,1);
});
test('host authorization failures pass through without attachment writes or fallback',async()=>{
 const reason=Object.assign(new Error('Room membership revoked'),{code:'ROOM_CAPTURE_SCOPE_REQUIRED'}),f=fixture({observe:async()=>{throw reason;}});
 await assert.rejects(f.run({action:'record-room',hallId}),e=>e===reason);assert.equal(f.calls.observe.length,1);assert.equal(f.calls.saveImage.length,0);
});
