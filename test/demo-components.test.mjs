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
 for(const actionStatus of ['performed','unknown']){let actions=0,stops=0,unsubscribed=0;const adapters={target:{validate:async identity=>({status:'pass',identity,evidence:{fixture:true}})},checks:{evaluate:async()=>({status:'pass',evidence:{fixture:true}})},action:{execute:async()=>{actions++;return{status:actionStatus,evidence:{fixture:true}};}},capture:{start:async()=>({status:'ready',readyAt:performance.now(),evidence:{fixture:true}}),stop:async()=>{stops++;return{status:'stopped',evidence:{fixture:true}};}},persistence:{begin:async()=>({fixture:true}),checkpoint:async()=>{},finish:async()=>{}}};
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
