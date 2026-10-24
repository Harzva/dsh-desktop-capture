import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import os from 'node:os';import {after} from 'node:test';
import * as api from '../demo/index.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url)),demo=path.resolve(directory,'../demo'),entry=path.join(demo,'index.mjs');
// Portable checkout tests. A maintainer may explicitly choose an existing private
// fixture parent; no volume name or machine-specific mount is required by the package.
const fixtureParent=process.env.OPENBOT_DEMO_TEST_TMPDIR||os.tmpdir();
assert.ok(path.isAbsolute(fixtureParent),'OPENBOT_DEMO_TEST_TMPDIR must be absolute');
const out=fs.mkdtempSync(path.join(fs.realpathSync(fixtureParent),'openbot-demo-components-'));
fs.chmodSync(out,0o700);after(()=>fs.rmSync(out,{recursive:true,force:true}));
const exports=['AXClient','createAXAdapters','validateTarget','createRunner','validatePlan','hashPlan','createFilePersistence','createRecordingAdapter','segmentsFromDirector','exportNarration','discoverTools'].sort();
const target={bundleId:'test.fixture',pid:123,processBirth:'1792671000.123456',windowId:42};
const locator={id:'00000000-0000-0000-0000-000000000000:1'},condition={kind:'ax',locator,property:'enabled',equals:true};
const plan={schemaVersion:1,id:'fixture-component-plan',target,maxRecordingSeconds:1,steps:[{id:'one',narration:'Fixture only.',holdMs:0,action:{type:'press',locator},precondition:condition,expected:condition}]};
test('aggregate API and recursively resolved production imports are self-contained',()=>{
 assert.deepEqual(Object.keys(api).sort(),exports);const seen=new Set();
 function visit(file){if(seen.has(file))return;seen.add(file);const source=fs.readFileSync(file,'utf8');assert.doesNotMatch(source,/\/Users\/|\/Volumes\/|research\/|-next\//);for(const m of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){const spec=m[1];if(spec.startsWith('node:'))continue;assert.ok(spec.startsWith('.'),'no package dependency');const resolved=path.resolve(path.dirname(file),spec);assert.ok(resolved.startsWith(demo+path.sep),'no dependency escapes component root');visit(resolved);}}
 visit(entry);assert.equal(seen.size,8);
});
const nativeArtifact=path.resolve(directory,'../native/demo-ax-helper');
test('built demo helper is arm64 Mach-O and strictly signed on macOS',{
 skip:!fs.existsSync(nativeArtifact)&&'Native artifact not built in this Git checkout; run npm run build:demo-native before release artifact verification'
},()=>{
 const native=path.resolve(directory,'../native/demo-ax-helper'),header=fs.readFileSync(native);
 assert.ok(header.length>=32,'complete Mach-O header');assert.equal(header.readUInt32LE(0),0xfeedfacf,'64-bit little-endian Mach-O');
 assert.equal(header.readUInt32LE(4),0x0100000c,'arm64 CPU type');
 if(process.platform==='darwin'){const signed=spawnSync('/usr/bin/codesign',['--verify','--strict',native],{encoding:'utf8'});assert.equal(signed.status,0,signed.stderr);}
 // Exact archive/helper hashes belong to the release catalog admission gate, not an obsolete fixture pin.

});
test('fresh import starts no process, writes nothing and reads no user data',()=>{
 const script=`import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {fileURLToPath} from 'node:url';import path from 'node:path';
 const root=${JSON.stringify(demo)};let deniedCalls=0;
 const deny=()=>{deniedCalls++;throw Error('Import side effect forbidden');};
 for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=deny;
 const permitted=x=>{if(x instanceof URL)x=fileURLToPath(x);return typeof x==='string'&&path.resolve(x).startsWith(root+path.sep)&&x.endsWith('.mjs');};
 for(const k of ['readFileSync','readFile','openSync','open','statSync','lstatSync','realpathSync','accessSync','createReadStream']){const real=fs[k];fs[k]=function(file,...args){if(!permitted(file))return deny();return real.call(this,file,...args);};}
 for(const k of ['readFile','open','stat','lstat','realpath','access']){const real=fs.promises[k];fs.promises[k]=function(file,...args){if(!permitted(file))return deny();return real.call(this,file,...args);};}
 for(const k of ['writeFile','writeFileSync','mkdir','mkdirSync','rename','renameSync','unlink','unlinkSync','rm','rmSync','link','linkSync'])if(fs[k])fs[k]=deny;
 for(const k of ['writeFile','mkdir','rename','unlink','rm','link'])if(fs.promises[k])fs.promises[k]=deny;
 syncBuiltinESMExports();const loaded=await import(${JSON.stringify(new URL('../demo/index.mjs',import.meta.url).href)});process.stdout.write(JSON.stringify({exports:Object.keys(loaded).sort(),deniedCalls}));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,maxBuffer:65536,env:{...process.env,HOME:out}});assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.deepEqual(data.exports,exports);assert.equal(data.deniedCalls,0);
});
test('strict plan/target schema and deterministic hash remain callable without native helpers',()=>{
 assert.deepEqual(api.validateTarget(target),target);assert.equal(api.hashPlan(plan),api.hashPlan(structuredClone(plan)));assert.ok(Object.isFrozen(api.validatePlan(plan)));
 for(const p of [{...plan,unexpected:true},{...plan,steps:[{...plan.steps[0],holdMs:1000}]},{...plan,steps:[{...plan.steps[0],action:{type:'shell',command:'forbidden'}}]}])assert.throws(()=>api.validatePlan(p));
 assert.throws(()=>api.validateTarget({...target,processBirth:'not-a-birth'}));assert.throws(()=>api.createAXAdapters({client:{}}));
});
test('director fixtures complete only verified effects and stop on unknown without replay',async()=>{
 for(const actionStatus of ['performed','unknown']){let actions=0,stops=0,unsubscribed=0;const adapters={target:{validate:async identity=>({status:'pass',identity,evidence:{fixture:true}})},checks:{evaluate:async()=>({status:'pass',evidence:{fixture:true}})},action:{execute:async()=>{actions++;return{status:actionStatus,evidence:{fixture:true}};}},capture:{start:async()=>({status:'ready',readyAt:performance.now(),evidence:{fixture:true}}),stop:async()=>{stops++;return{status:'stopped',evidence:{fixture:true,mediaState:'complete',publishable:true}};}},persistence:{begin:async()=>({fixture:true}),checkpoint:async()=>{},finish:async()=>{}}};
 const state=await api.createRunner({adapters}).run({plan,host:{botId:'fixture-existing-bot',taskId:'fixture-existing-task',onStop:()=>()=>{unsubscribed++;}}});assert.equal(actions,1);assert.equal(stops,1);assert.equal(unsubscribed,1);assert.equal(state.status,actionStatus==='performed'?'completed':'paused');if(actionStatus==='unknown'){assert.equal(state.reason,'action_unknown');assert.throws(()=>api.segmentsFromDirector(state));}}
});
test('own-source recording adapter reuses injected exact service and identity, not a recorder',async()=>{
 const id='a'.repeat(32),own={...target,pid:process.pid},calls=[],recording={start:async(bot,args)=>{calls.push(['start',bot,args.source]);await args.guard();return{ok:true,recordingId:id,botId:bot,state:'recording'};},stop:async()=>({ok:true,recordingId:id}),cancel:async()=>{},statusExact:async()=>({recordingId:id,state:'closed',captureClosed:true,startSettled:true}),release:async()=>calls.push(['release',id])};
 const adapter=api.createRecordingAdapter({recording,botId:'fixture-existing-bot',source:'app',target:own,resolveOwnRecordingTarget:async()=>({windowId:own.windowId,app:{pid:own.pid,bundle:own.bundleId,launchDate:Number(own.processBirth)},validate:async()=>{}}),guard:async()=>{}}),ctx={binding:{host:{botId:'fixture-existing-bot',taskId:'fixture-task'},target:own},maxRecordingSeconds:1};
 assert.equal((await adapter.start(ctx)).status,'ready');assert.equal((await adapter.stop({...ctx,reason:'done'})).status,'stopped');assert.deepEqual(calls,[['start','fixture-existing-bot','app'],['release',id]]);assert.equal(adapter.fenced,false);
});
function helper(mode){const file=out+'/'+mode+'.mjs';fs.writeFileSync(file,`#!/usr/bin/env node\nimport {createInterface} from 'node:readline';${mode==='slow'?'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),350);':''}createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);console.log(JSON.stringify({requestId:r.requestId,ok:true,result:{status:'fixture-only',evidence:{fixture:true}}}));});`,{mode:0o755});return new api.AXClient({binary:file});}
test('closeAndWait observes actual owned Node helper exit and close; close stays synchronous',async()=>{
 const client=helper('normal');assert.equal((await client.probe()).status,'fixture-only');assert.equal(client.close(),undefined);const r=await client.closeAndWait();assert.equal(r.status,'closed');assert.equal(r.evidence.exitObserved,true);assert.equal(r.evidence.closeObserved,true);assert.equal(r.evidence.physicalExitConfirmed,true);assert.equal((await client.closeAndWait()).evidence.pid,r.evidence.pid);await assert.rejects(client.probe(),{code:'fenced'});
});
test('cleanup timeout is unconfirmed, then same child may exit; never restart or replay',async()=>{
 const client=helper('slow');assert.equal((await client.probe()).status,'fixture-only');await assert.rejects(client.closeAndWait({timeoutMs:10}),e=>e.code==='AX_CLEANUP_UNCONFIRMED'&&e.nativeEvidence.closeObserved===false);assert.equal(client.fenced,true);const closed=await client.closeAndWait({timeoutMs:1500});assert.equal(closed.status,'closed');assert.equal(closed.evidence.code,0);assert.equal(closed.evidence.physicalExitConfirmed,true);
});
console.log('DEMO_COMPONENT_TEST_OUTPUT='+out);

// Protocol fixtures below test truthful lifecycle states, not real media.
function recordingFixture({closed=true,mediaState='partial',stopFails=true}={}) {
 const id='b'.repeat(32), own={...target,pid:process.pid}, counts={stop:0,release:0,validate:0};
 let startOptions, revoked=false, targetLost=false;
 const service={
  start:async(bot,args)=>{startOptions=args;await args.guard();return{ok:true,recordingId:id,botId:bot,state:'recording'};},
  stop:async()=>{counts.stop++;if(stopFails)throw Object.assign(Error('Original target disappeared'),{code:'APP_RECORDING_TARGET_LOST'});return{ok:true,recordingId:id};},
  cancel:async()=>{},
  statusExact:async()=>({recordingId:id,state:closed?'closed':'stopping',captureClosed:closed,startSettled:true,mediaState,publishable:mediaState==='complete'}),
  release:async()=>{counts.release++;}
 };
 const create=()=>api.createRecordingAdapter({recording:service,botId:'fixture-existing-bot',source:'app',target:own,
  resolveOwnRecordingTarget:async()=>({windowId:own.windowId,app:{pid:own.pid,bundle:own.bundleId,launchDate:Number(own.processBirth)},validate:async()=>{counts.validate++;if(targetLost)throw Error('Target disappeared');}}),
  guard:async()=>{if(revoked)throw Object.assign(Error('Authority revoked'),{code:'REVOKED'});}});
 return {create,counts,ctx:{binding:{host:{botId:'fixture-existing-bot',taskId:'fixture-task'},target:own},maxRecordingSeconds:1},
  get options(){return startOptions;},setClosed:()=>{closed=true;},loseTarget:()=>{targetLost=true;},revoke:()=>{revoked=true;}};
}
test('closed partial stop is not fenced or publishable, exact release occurs once',async()=>{
 const f=recordingFixture(),a=f.create();await a.start(f.ctx);
 const [one,two]=await Promise.all([a.stop({...f.ctx,reason:'target_changed'}),a.stop({...f.ctx,reason:'target_changed'})]);
 assert.deepEqual(one,two);assert.equal(one.status,'stopped');assert.equal(one.evidence.physicalClosure.captureClosed,true);
 assert.equal(one.evidence.mediaState,'partial');assert.equal(one.evidence.publishable,false);
 assert.equal(one.evidence.mediaError.code,'APP_RECORDING_TARGET_LOST');assert.equal(a.metadata,null);assert.equal(a.fenced,false);
 assert.deepEqual([f.counts.stop,f.counts.release],[1,1]);
 const next=f.create();assert.equal((await next.start(f.ctx)).status,'ready');await next.stop({...f.ctx,reason:'cancelled'});
});
test('unknown process closure stays fenced until exact explicit reconciliation',async()=>{
 const f=recordingFixture({closed:false}),a=f.create();await a.start(f.ctx);
 const stopped=await a.stop({...f.ctx,reason:'target_changed'});
 assert.equal(stopped.status,'unknown');assert.equal(a.fenced,true);assert.equal(f.counts.release,0);
 await assert.rejects(f.create().start(f.ctx),/active or fenced/);
 f.setClosed();const reconciled=await a.reconcile(f.ctx);
 assert.equal(reconciled.status,'stopped');assert.equal(reconciled.evidence.publishable,false);assert.equal(f.counts.release,1);
});
test('cleanup guard permits only existing-byte finalization after target loss, still rejects revoked authority',async()=>{
 const f=recordingFixture(),a=f.create();await a.start(f.ctx);f.loseTarget();
 await assert.rejects(f.options.guard(),/Target disappeared/);
 const before=f.counts.validate;await f.options.cleanupGuard();assert.equal(f.counts.validate,before);
 f.revoke();await assert.rejects(f.options.cleanupGuard(),{code:'REVOKED'});await a.stop({...f.ctx,reason:'cancelled'});
});

async function directorFailureFixture({stopStatus='stopped',publishable=false,mediaState='partial',loseTarget=false}={}) {
 const root=fs.mkdtempSync(path.join(out,'terminal-'));fs.chmodSync(root,0o700);
 const persistence=api.createFilePersistence({root});let actions=0,stops=0;
 const adapters={
  target:{validate:async identity=>({status:loseTarget&&actions?'fail':'pass',identity,evidence:{fixture:true}})},
  checks:{evaluate:async()=>({status:'pass',evidence:{fixture:true}})},
  action:{execute:async()=>{actions++;return{status:'performed',evidence:{fixture:true}};}},
  capture:{start:async()=>({status:'ready',readyAt:performance.now(),evidence:{fixture:true}}),stop:async()=>{stops++;return{status:stopStatus,evidence:{fixture:true,...(mediaState===null?{}:{mediaState}),publishable,...(!publishable?{mediaError:{code:'APP_RECORDING_TARGET_LOST',message:'Fixture target lost'}}:{})}};}},
  persistence
 };
 const twoSteps={...plan,maxRecordingSeconds:60,steps:[plan.steps[0],{...plan.steps[0],id:'two'}]};
 const state=await api.createRunner({adapters}).run({plan:twoSteps,host:{botId:'fixture-existing-bot',taskId:'fixture-existing-task',onStop:()=>()=>{}}});
 return {root,state,actions,stops,persistence};
}
test('verified actions plus partial, unusable or unspecified media cannot complete or narrate a demo',async()=>{
 for(const mediaState of ['partial','unusable',null]){
  const f=await directorFailureFixture({mediaState});assert.equal(f.actions,2);assert.equal(f.stops,1);
  assert.equal(f.state.status,'paused');assert.equal(f.state.reason,'capture_media_incomplete');assert.equal(f.state.capture.status,'stopped');assert.equal(f.state.capture.publishable,false);
  assert(!f.state.events.some(e=>e.type==='run_completed'));assert.throws(()=>api.segmentsFromDirector(f.state));
  assert.throws(()=>api.segmentsFromDirector({...f.state,status:'completed'}),/Partial or unusable/);
  assert.equal(fs.readdirSync(path.join(f.root,'.locks')).length,0);
 }
});
test('target halt keeps its original reason when partial media is physically closed and releases persistence locks',async()=>{
 const f=await directorFailureFixture({loseTarget:true});assert.equal(f.actions,1);assert.equal(f.stops,1);
 assert.equal(f.state.status,'paused');assert.equal(f.state.reason,'target_changed');assert.equal(f.state.capture.status,'stopped');
 assert.equal(f.state.capture.mediaError.code,'APP_RECORDING_TARGET_LOST');assert.equal(f.state.capture.publishable,false);
 assert.equal(f.state.timeline[1].status,'pending');assert.equal(fs.readdirSync(path.join(f.root,'.locks')).length,0);
 assert.deepEqual(f.persistence.readRecovery(f.state.binding),f.state);
});
test('target halt survives unknown cleanup, which retains persistent fences and secondary error',async()=>{
 const f=await directorFailureFixture({loseTarget:true,stopStatus:'unknown'});
 assert.equal(f.actions,1);assert.equal(f.state.reason,'target_changed');assert.equal(f.state.capture.status,'unknown');
 assert.equal(f.state.cleanupError.reason,'capture_stop_failed');assert.equal(f.state.capture.publishable,false);
 assert.equal(fs.readdirSync(path.join(f.root,'.locks')).length,2);
 await assert.rejects(f.persistence.begin({...f.state.binding,planId:'new-plan'}));
});
