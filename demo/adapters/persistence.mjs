import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const C=fs.constants,MAX=8*1024*1024;
const err=(code,message=code)=>Object.assign(new Error(message),{code});
const check=(ok,code)=>{if(!ok)throw err(code);};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const json=x=>{const s=JSON.stringify(x);check(s&&Buffer.byteLength(s)<=MAX,'STATE_LIMIT');return s;};
const canonical=x=>Array.isArray(x)?`[${x.map(canonical).join(',')}]`:plain(x)?`{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`:JSON.stringify(x);
const digest=x=>createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const copy=x=>JSON.parse(json(x));
const text=x=>typeof x==='string'&&x.length>0&&x.length<=256;
function binding(b){
 check(plain(b)&&same(Object.keys(b).sort(),['host','planHash','planId','target']),'BINDING_INVALID');
 check(text(b.planId)&&typeof b.planHash==='string'&&/^[a-f0-9]{64}$/.test(b.planHash)&&plain(b.host)&&same(Object.keys(b.host).sort(),['botId','taskId'])&&text(b.host.botId)&&text(b.host.taskId),'BINDING_INVALID');
 check(plain(b.target)&&same(Object.keys(b.target).sort(),['bundleId','pid','processBirth','windowId'])&&text(b.target.bundleId)&&Number.isSafeInteger(b.target.pid)&&b.target.pid>0&&text(b.target.processBirth)&&(text(b.target.windowId)||(Number.isSafeInteger(b.target.windowId)&&b.target.windowId>0)),'BINDING_INVALID');
 return copy(b);
}
function directory(p){
 check(path.isAbsolute(p)&&path.resolve(p)===p,'PATH_INVALID');
 let current=path.parse(p).root;
 for(const part of p.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=fs.lstatSync(current);check(s.isDirectory()&&!s.isSymbolicLink(),'DIRECTORY_UNSAFE');}
 check(fs.realpathSync(p)===p,'DIRECTORY_UNSAFE');const s=fs.lstatSync(p);
 check(s.uid===process.getuid()&&(s.mode&0o077)===0,'DIRECTORY_NOT_PRIVATE');return {dev:s.dev,ino:s.ino};
}
const stamp=p=>{const s=fs.lstatSync(p);return {dev:s.dev,ino:s.ino};};
function fsyncDir(p){const fd=fs.openSync(p,C.O_RDONLY|C.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
async function syncDir(p){const fd=await fs.promises.open(p,C.O_RDONLY|C.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
function safeRead(p){
 const fd=fs.openSync(p,C.O_RDONLY|C.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);check(s.isFile()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.nlink===1&&s.size<=MAX,'FILE_UNSAFE');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
}
async function writeNew(p,value){const fd=await fs.promises.open(p,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);try{await fd.writeFile(json(value)+'\n');await fd.sync();}finally{await fd.close();}}
function safeDestination(p){try{safeRead(p);}catch(e){if(e.code!=='ENOENT')throw e;}}
async function atomic(p,value){
 safeDestination(p);const temp=path.join(path.dirname(p),'.atomic-'+randomUUID());await writeNew(temp,value);
 try{safeDestination(p);await fs.promises.rename(temp,p);await syncDir(path.dirname(p));}catch(e){throw e;} // partial temp retained, never silently replayed
}
function ensureDir(p){try{fs.mkdirSync(p,{mode:0o700});fsyncDir(path.dirname(p));}catch(e){if(e.code!=='EEXIST')throw e;}return directory(p);}
function events(list,b,previous=[]){
 check(Array.isArray(list)&&list.length<=4096&&list.length>=previous.length,'EVENTS_INVALID');let at=-Infinity;
 for(let i=0;i<list.length;i++){const e=list[i];check(plain(e)&&e.seq===i+1&&Number.isFinite(e.at)&&e.at>=at&&text(e.type)&&same(e.binding,b),'EVENTS_INVALID');if(i<previous.length)check(same(e,previous[i]),'EVENT_PREFIX_CHANGED');at=e.at;}
}
function stateCheck(s,b,prior,recovery=false){
 check(plain(s)&&s.schemaVersion===1&&same(s.binding,b)&&Array.isArray(s.timeline)&&['running','completed','paused','cancelled'].includes(s.status),'STATE_BINDING_INVALID');
 events(s.events,b,prior?.events);
 if(recovery){check(s.status==='paused'&&s.reason==='recovered_requires_replan'&&same(s.events,prior.events),'RECOVERY_MUST_NOT_EXECUTE');events(s.recoveryEvents,b,prior.recoveryEvents||[]);}
 return copy(s);
}

/** Durable host capability. Root must already exist, be current-user-private and contain no symlink components. */
export function createFilePersistence({root}={}){
 const rootIdentity=directory(root),tokens=new WeakMap();const locks=path.join(root,'.locks'),locksIdentity=ensureDir(locks);
 const assertRoot=()=>{check(same(directory(root),rootIdentity),'ROOT_CHANGED');check(same(directory(locks),locksIdentity),'LOCK_DIRECTORY_CHANGED');};
 const runPath=b=>path.join(root,'run-'+digest(binding(b)));
 const assertRun=r=>{assertRoot();check(same(directory(r.dir),r.identity),'RUN_CHANGED');};
 const assertLease=r=>{assertRun(r);const lease=safeRead(path.join(r.dir,'lease.json'));check(lease.nonce===r.nonce&&same(lease.binding,r.binding),'LEASE_CHANGED');for(const p of r.locks)check(safeRead(p).nonce===r.nonce,'LEASE_CHANGED');};
 const removeOwn=async(p,nonce)=>{const s=safeRead(p);check(s.nonce===nonce,'LEASE_CHANGED');await fs.promises.unlink(p);await syncDir(path.dirname(p));};
 function load(b){
  assertRoot();b=binding(b);const dir=runPath(b);directory(dir);check(same(safeRead(path.join(dir,'binding.json')),b),'BINDING_MISMATCH');
  const pointer=safeRead(path.join(dir,'snapshot.json'));check(pointer.schemaVersion===1&&Number.isSafeInteger(pointer.revision)&&pointer.revision>=1&&pointer.revision<=4096,'SNAPSHOT_INVALID');
  let prior=null,previousDigest=null,last;
  for(let i=1;i<=pointer.revision;i++){
   const record=safeRead(path.join(dir,`checkpoint-${String(i).padStart(6,'0')}.json`));
   check(record.revision===i&&record.previousDigest===previousDigest&&record.digest===digest(record.state),'CHECKPOINT_CHAIN_INVALID');
   stateCheck(record.state,b,prior);prior=record.state;previousDigest=record.digest;last=record;
  }
  check(pointer.digest===last.digest&&pointer.bindingDigest===digest(b),'SNAPSHOT_INVALID');
  return {dir,state:copy(last.state)};
 }
 async function commit(r,s){
  check(!r.finished&&!r.fenced,'LEASE_FENCED');assertLease(r);s=stateCheck(s,r.binding,r.prior,r.recovery);
  const revision=r.revision+1;check(revision<=4096,'CHECKPOINT_LIMIT');const record={schemaVersion:1,revision,previousDigest:r.lastDigest,digest:digest(s),state:s};
  await writeNew(path.join(r.dir,`checkpoint-${String(revision).padStart(6,'0')}.json`),record);await syncDir(r.dir);assertLease(r);
  await atomic(path.join(r.dir,'snapshot.json'),{schemaVersion:1,revision,digest:record.digest,bindingDigest:digest(r.binding)});
  r.revision=revision;r.lastDigest=record.digest;r.prior=s;
 }
 return {
  directoryFor:runPath,
  readRecovery(b){return load(b).state;}, // strictly read-only; caller must pass this snapshot to director.run({resume})
  async begin(input,{resume=null}={}){
   assertRoot();const b=binding(input),nonce=randomUUID(),ownedLocks=[];let dir=runPath(b),recovery=false,prior=null;
   if(resume!==null){
    const existing=load(b);check(same(existing.state,resume),'RECOVERY_SNAPSHOT_CHANGED');prior=copy(resume);recovery=true;
    const recoveryRoot=path.join(dir,'recoveries');ensureDir(recoveryRoot);dir=path.join(recoveryRoot,nonce);fs.mkdirSync(dir,{mode:0o700});
   }else{
    // Locks cover the existing host identity and stable target across distinct plans/processes.
    try{for(const [kind,value]of[['host',b.host],['target',b.target]]){const p=path.join(locks,kind+'-'+digest(value)+'.json');await writeNew(p,{nonce,binding:b,pid:process.pid});ownedLocks.push(p);await syncDir(locks);}fs.mkdirSync(dir,{mode:0o700});}
    catch(e){for(const p of ownedLocks){try{await removeOwn(p,nonce);}catch{}}throw e;}
   }
   const r={dir,identity:directory(dir),binding:b,nonce,locks:ownedLocks,recovery,prior,revision:0,lastDigest:null,finished:false,fenced:false};
   // After the run exists, setup/commit failures retain fences for explicit host reconciliation.
   await writeNew(path.join(dir,'binding.json'),b);await writeNew(path.join(dir,'lease.json'),{schemaVersion:1,nonce,binding:b,pid:process.pid,recovery});await syncDir(dir);await syncDir(path.dirname(dir));
   const token=Object.freeze({directory:dir,recovery});tokens.set(token,r);return token;
  },
  async checkpoint(token,s){const r=tokens.get(token);check(r,'LEASE_INVALID');check(!r.busy,'CHECKPOINT_CONCURRENT');r.busy=true;try{await commit(r,s);}catch(e){r.fenced=true;throw e;}finally{r.busy=false;}},
  async finish(token,s){
   const r=tokens.get(token);check(r,'LEASE_INVALID');
   check(!r.busy,'CHECKPOINT_CONCURRENT');r.busy=true;
   try{
    await commit(r,s);assertLease(r);
    const fenced=!r.recovery&&(s.capture?.status==='unknown'||s.status==='running');
    await writeNew(path.join(r.dir,'finish.json'),{schemaVersion:1,nonce:r.nonce,binding:r.binding,status:s.status,fenceRetained:fenced});await syncDir(r.dir);
    if(!fenced){await removeOwn(path.join(r.dir,'lease.json'),r.nonce);for(const p of r.locks)await removeOwn(p,r.nonce);}
    r.finished=true;r.fenced=fenced;
   }catch(e){r.fenced=true;throw e;}finally{r.busy=false;} // never removes a changed/foreign lease or retries a failed commit
  }
 };
}
