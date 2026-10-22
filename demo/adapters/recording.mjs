const sessions=new WeakMap();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=t=>JSON.stringify([t?.bundleId,t?.pid,t?.processBirth,t?.windowId]);
const error=(code,message=code)=>Object.assign(new Error(message),{code});
const check=(ok,message)=>{if(!ok)throw error('DEMO_RECORDING_INVALID',message);};

/** Reuses the host's one AppRecording service. Generic demos must not mint room reservation scopes. */
export function createRecordingAdapter({recording,botId,source='application',targetId,target,windowId=target?.windowId,resolveRecordingTarget,resolveOwnRecordingTarget,guard}={}){
 for(const key of ['start','stop','cancel','statusExact','release'])check(typeof recording?.[key]==='function',`Required AppRecording.${key}`);
 check(typeof botId==='string'&&botId&&['app','application'].includes(source),'Only own or explicitly selected application capture is supported');
 check(Number.isSafeInteger(windowId)&&windowId>0&&target?.windowId===windowId,'Selected CGWindowID required');
 check(typeof target?.bundleId==='string'&&Number.isSafeInteger(target.pid)&&target.pid>0&&typeof target.processBirth==='string'&&/^\d+(?:\.\d{1,6})?$/.test(target.processBirth)&&Number(target.processBirth)>0,'Explicit AX process identity required');
 const own=source==='app';
 check(own?targetId===undefined&&target.pid===process.pid:/^[a-f0-9]{32}$/.test(targetId||''),'Own capture must belong to this host process without a target token; external capture requires its opaque token');
 check(typeof (own?resolveOwnRecordingTarget:resolveRecordingTarget)==='function'&&typeof guard==='function','Trusted target resolver and execution guard required');
 const evidence=(s,extra={})=>({adapter:'existing-AppRecording',recordingId:s?.id??null,source,...extra});
 const unknown=(s,e)=>({status:'unknown',evidence:evidence(s,{error:String(e?.message||e).slice(0,2000),fenceRetained:!!s?.called&&!s?.closed})});
 target=structuredClone(target);let s,used=false;
 const bind=ctx=>check(ctx?.binding?.host?.botId===botId&&canonical(ctx.binding.target)===canonical(target),'Director binding does not match trusted Bot/target');
 async function end(cancel){
  if(!s||!s.called){if(s&&sessions.get(recording)===s)sessions.delete(recording);return {status:'stopped',evidence:evidence(s,{noRecordingStarted:true})};}
  if(!s.id)return unknown(s,'Start outcome has no acknowledged recordingId; host reconciliation required');
  if(s.stopPromise)return s.stopPromise;
  s.stopPromise=(async()=>{
   try{
    let failure;
    try{const result=await recording[cancel?'cancel':'stop'](botId,s.id);if(!cancel)s.metadata=structuredClone(result);}catch(e){failure=e;}
    const status=await recording.statusExact(botId,s.id);
    check(status?.recordingId===s.id&&status.state==='closed'&&status.captureClosed===true&&status.startSettled===true,'Exact physical closure not confirmed');
    if(failure&&!cancel)throw failure; // finalized-error media is not successful recording/export material
    await recording.release(botId,s.id);
    if(sessions.get(recording)===s)sessions.delete(recording);s.closed=true;
    return {status:'stopped',evidence:evidence(s,{cancelled:cancel,physicalClosure:status,...(s.metadata?{metadata:s.metadata}:{})})};
   }catch(e){s.fenced=true;return unknown(s,e);}
  })();return s.stopPromise;
 }
 return {
  async start(ctx){
   bind(ctx);check(!used,'Adapter is single-use; no restart or replay');check(!sessions.has(recording),'An existing demo recording operation is active or fenced');
   used=true;s={binding:structuredClone(ctx.binding),id:null,called:false,closed:false,fenced:false,aborted:false};sessions.set(recording,s);
   s.controller=new AbortController();
   const signal=ctx.signal?AbortSignal.any([ctx.signal,s.controller.signal]):s.controller.signal,abort=()=>{s.aborted=true;if(s.id)void end(true);};signal.addEventListener('abort',abort,{once:true});s.unsubscribe=()=>signal.removeEventListener('abort',abort);
   try{
    check(!signal?.aborted,'Cancelled before recording');await guard(s.binding);check(!signal?.aborted,'Cancelled before target resolution');
    const resolution={signal,guard:()=>guard(s.binding)};
    const resolved=own?await resolveOwnRecordingTarget(resolution):await resolveRecordingTarget(targetId,resolution);
    check(resolved?.windowId===windowId&&resolved.app?.pid===target.pid&&resolved.app?.bundle===target.bundleId&&Number.isFinite(resolved.app?.launchDate)&&Math.abs(resolved.app.launchDate-Number(target.processBirth))<0.000001&&typeof resolved.validate==='function','Capture target differs from AX-selected process/window');
    const live=async()=>{if(signal?.aborted)throw error('ABORTED');await guard(s.binding);await resolved.validate();if(signal?.aborted)throw error('ABORTED');};
    await live();check(Number.isInteger(ctx.maxRecordingSeconds)&&ctx.maxRecordingSeconds>=1&&ctx.maxRecordingSeconds<=180,'Recording duration must be integer 1–180 seconds');
    s.called=true;
    const ready=await recording.start(botId,{source,...(!own?{targetId}:{}),maxDurationSeconds:ctx.maxRecordingSeconds,signal,guard:live});
    check(ready?.ok===true&&typeof ready.recordingId==='string'&&/^[a-f0-9]{32}$/.test(ready.recordingId)&&ready.botId===botId,'Invalid owned recording acknowledgement');
    s.id=ready.recordingId;
    if(signal?.aborted||s.aborted){await end(true);throw error('ABORTED');}
    check(ready.state==='recording','Invalid native-ready acknowledgement');
    // This is the observed ready acknowledgement, not invented media PTS or a backdated timestamp.
    const readyAt=performance.now();s.readyAt=readyAt;
    return {status:'ready',readyAt,evidence:evidence(s,{identity:target,readyAcknowledgement:ready,clock:'performance.now; host-observed native ready acknowledgement, raw first-frame PTS unavailable'})};
   }catch(e){s.fenced=s.called&&!s.closed;return unknown(s,e);}
  },
  async stop(ctx){bind(ctx);if(s)check(same(s.binding,ctx.binding),'Run binding changed');
   if(s&&!s.id&&!s.closed){s.aborted=true;s.controller.abort();} // Stop during unresolved start may only cancel this start, never adopt mutable active.
   s?.unsubscribe?.();return end(!!s?.aborted||ctx.reason==='cancelled'||ctx.reason==='recording_limit');},
  async reconcile(ctx){
   bind(ctx);check(s?.fenced&&s.id,'Only a known fenced exact recording may be explicitly reconciled');
   check(same(s.binding,ctx.binding),'Run binding changed');
   const status=await recording.statusExact(botId,s.id);
   check(status.recordingId===s.id&&status.state==='closed'&&status.captureClosed===true&&status.startSettled===true,'Physical closure is still unknown');
   await recording.release(botId,s.id);if(sessions.get(recording)===s)sessions.delete(recording);s.fenced=false;s.closed=true;
   return {status:'stopped',evidence:evidence(s,{reconciled:true,physicalClosure:status})};
  },
  get recordingId(){return s?.id??null;},
  get metadata(){return s?.metadata?structuredClone(s.metadata):null;},
  get fenced(){return !!s?.fenced;}
 };
}
