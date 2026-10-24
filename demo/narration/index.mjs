import {constants,createReadStream} from 'node:fs';
import {access,lstat,realpath,mkdir,writeFile,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runProcess} from './process.mjs';

const ensure=(ok,message)=>{if(!ok)throw new TypeError(message);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,allowed)=>{ensure(object(x),'Expected object');ensure(Object.keys(x).every(k=>allowed.includes(k)),'Unknown field');};
const text=(x,max=4000)=>typeof x==='string'&&x.trim()&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const check=signal=>{if(signal?.aborted)throw new Error('Cancelled');};
const writeJSON=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
export function validateSegments(segments) {
  ensure(Array.isArray(segments)&&segments.length>=1&&segments.length<=30,'Expected 1–30 segments');
  let previous=0;const ids=new Set();
  return segments.map(s=>{
    exact(s,['id','text','startMs','endMs']);
    ensure(text(s.id,128)&&!ids.has(s.id),'Invalid or duplicate segment id');ids.add(s.id);
    ensure(text(s.text)&&!s.text.includes('[[')&&!s.text.includes(']]')&&!s.text.includes('-->'),'Narration must be plain single-line text');
    ensure(Number.isInteger(s.startMs)&&Number.isInteger(s.endMs)&&s.startMs>=previous&&s.endMs>s.startMs&&s.endMs<=180000,'Invalid, overlapping or unordered segment time');
    previous=s.endMs;return {...s};
  });
}
const stamp=ms=>`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
export function toSRT(segments) {return validateSegments(segments).map((s,i)=>`${i+1}\n${stamp(s.startMs)} --> ${stamp(s.endMs)}\n${s.text}\n`).join('\n');}
export function assertSpeechFits(segment,speechSeconds) {
  ensure(Number.isFinite(speechSeconds)&&speechSeconds>0,'Unknown speech duration');
  if(speechSeconds*1000>segment.endMs-segment.startMs)throw new Error(`Narration overflow for ${segment.id}: ${(speechSeconds*1000).toFixed(3)}ms > ${segment.endMs-segment.startMs}ms; extend the explicit segment or shorten text`);
}

// Uses actual verified windows, never inferred pauses or synthetic timings.
export function segmentsFromDirector(state) {
  ensure(state?.schemaVersion===1&&state.status==='completed'&&state.capture?.status==='stopped','Director run/capture must be completed/stopped');
  ensure(state.capture.publishable!==false&&(!state.capture.mediaState||state.capture.mediaState==='complete'),'Partial or unusable capture cannot be narrated as a completed demo');
  ensure(Number.isFinite(state.capture.readyAt)&&Array.isArray(state.timeline),'Missing capture clock or timeline');
  ensure(object(state.binding)&&text(state.binding.planId,128)&&text(state.binding.planHash,128),'Missing director binding');
  const segments=state.timeline.map(s=>{
    ensure(s.status==='verified'&&Number.isFinite(s.startedAt)&&Number.isFinite(s.verifiedAt),'Unverified director step');
    const completedAt=s.completedAt??s.verifiedAt;
    ensure(Number.isFinite(completedAt)&&completedAt>=s.verifiedAt,'Invalid director completion timestamp');
    return {id:s.stepId,text:s.narration,startMs:Math.ceil(s.startedAt-state.capture.readyAt),endMs:Math.floor(completedAt-state.capture.readyAt)};
  });
  return {segments:validateSegments(segments),binding:structuredClone(state.binding)};
}
async function binary(name) {
  const candidates=name==='say'?['/usr/bin/say']:(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(d=>path.resolve(d,name));
  for(const file of candidates)try{await access(file,constants.X_OK);return await realpath(file);}catch{}
  throw new Error(`Missing existing executable: ${name}; no dependencies installed`);
}
export async function discoverTools({signal}={}) {
  const tools={say:await binary('say'),ffmpeg:await binary('ffmpeg'),ffprobe:await binary('ffprobe')};
  const ffmpeg=await runProcess(tools.ffmpeg,['-version'],{signal,timeoutMs:10000});
  const ffprobe=await runProcess(tools.ffprobe,['-version'],{signal,timeoutMs:10000});
  const voices=await runProcess(tools.say,['-v','?'],{signal,timeoutMs:10000});
  return {...tools,ffmpegVersion:ffmpeg.stdout.split('\n')[0],ffprobeVersion:ffprobe.stdout.split('\n')[0],voices:voices.stdout.split('\n').map(line=>line.match(/^(.*?)\s+[a-z]{2,3}_[A-Z0-9]+\s+#/u)?.[1].trim()).filter(Boolean)};
}
async function probe(tools,file,signal) {
  const {stdout}=await runProcess(tools.ffprobe,['-v','error','-protocol_whitelist','file','-show_format','-show_streams','-of','json',file],{signal,timeoutMs:15000});
  return JSON.parse(stdout);
}
async function hash(file) {const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
function duration(info) {const n=Number(info.format?.duration);ensure(Number.isFinite(n)&&n>0,'Unknown media duration');return n;}
function localMedia(info) {
  ensure(Array.isArray(info.streams),'Missing media streams');
  ensure(info.format?.format_name?.split(',').includes('mp4'),'Source must be an MP4 container');
  ensure(info.streams.filter(s=>s.codec_type==='video').length===1&&!info.streams.some(s=>s.disposition?.attached_pic),'Expected exactly one video stream');
  ensure(info.streams.filter(s=>s.codec_type==='audio').length<=4,'At most four original audio tracks');
  ensure(info.streams.filter(s=>['video','audio'].includes(s.codec_type)).every(s=>Number.isFinite(Number(s.start_time))&&Number(s.start_time)>=-0.001&&Number(s.start_time)<=0.1),'Unknown/nonzero media start times need explicit remapping');
}

// Private composition stage. Only exportNarration admits output/source data in production.
// Tests exercise this exact body through a test-only module copy; no new public API.
async function composeFilm({tools,source,sourceInfo,seconds,sourceHash,outputDir,signal}) {
  check(signal);
  const out=name=>path.join(outputDir,name);
  // exportNarration owns an exclusively created private directory. Reject stale
  // stage artifacts too: a skipped -n output is not evidence of fresh work.
  for(const name of ['mix.m4a','film.partial.mp4','film.mp4']) {
    try { await lstat(out(name)); throw Object.assign(new Error(`Composition output already exists: ${name}`),{code:'EEXIST'}); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  check(signal);
  const common=['-hide_banner','-loglevel','error','-nostdin','-n','-threads','1','-filter_complex_threads','1'];
  const audio=sourceInfo.streams.filter(s=>s.codec_type==='audio');
  const mix=audio.length?'[0:a:0]volume=0.5[original];[original][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=false[mix]':'[1:a]anull[mix]';
  // This combined filter+direct-map path stalled on the observed 54-second input.
  // Materialize its unchanged mix first; no unverified FFmpeg internal cause is assumed.
  await runProcess(tools.ffmpeg,[...common,'-protocol_whitelist','file','-i',source,'-protocol_whitelist','file','-i',out('narration.wav'),'-filter_complex',mix,'-map','[mix]','-c:a','aac','-b:a','192k',out('mix.m4a')],{signal});
  const maps=['-map','0:v:0','-map','1:a:0',...audio.flatMap((_,i)=>['-map',`0:a:${i}`]),'-map','2:a:0'];
  const audioOptions=['-c:a','copy','-disposition:a:0','default','-metadata:s:a:0','title=Narration mix','-metadata:s:a:0','handler_name=Narration mix'];
  for(let i=0;i<audio.length;i++)audioOptions.push(`-disposition:a:${i+1}`,'0',`-metadata:s:a:${i+1}`,`title=Original audio ${i+1}`,`-metadata:s:a:${i+1}`,`handler_name=Original audio ${i+1}`);
  audioOptions.push(`-c:a:${audio.length+1}`,'aac',`-b:a:${audio.length+1}`,'192k',`-disposition:a:${audio.length+1}`,'0',`-metadata:s:a:${audio.length+1}`,'title=Narration only',`-metadata:s:a:${audio.length+1}`,'handler_name=Narration only');
  await runProcess(tools.ffmpeg,[...common,'-protocol_whitelist','file','-i',source,'-protocol_whitelist','file','-i',out('mix.m4a'),'-protocol_whitelist','file','-i',out('narration.wav'),...maps,'-c:v','copy',...audioOptions,'-map_metadata','0','-movflags','+faststart',out('film.partial.mp4')],{signal});
  const finalInfo=await probe(tools,out('film.partial.mp4'),signal);
  ensure(Math.abs(duration(finalInfo)-seconds)<=0.15,'Export duration differs from original');
  ensure(finalInfo.streams.filter(s=>s.codec_type==='audio').length===audio.length+2,'Missing exported audio tracks');
  // Decode every output stream; successful mux/probe alone is not playability evidence.
  await runProcess(tools.ffmpeg,[...common,'-protocol_whitelist','file','-i',out('film.partial.mp4'),'-map','0:v','-map','0:a','-f','null','-'],{signal});
  check(signal);ensure(await hash(source)===sourceHash,'Original source changed during export');
  // Same-directory hard-link publication fails atomically if the final name exists.
  // Keep partial on any publication failure; this is not a replay/recovery entry.
  check(signal);await link(out('film.partial.mp4'),out('film.mp4'));
  await unlink(out('film.partial.mp4'));
  return finalInfo;
}

export async function exportNarration(request,{signal}={}) {
  exact(request,['schemaVersion','source','outputDir','voice','rate','segments','binding']);
  ensure(request.schemaVersion===1,'Unsupported schema version');
  const segments=validateSegments(request.segments),rate=request.rate??180;
  ensure(Number.isInteger(rate)&&rate>=80&&rate<=300,'Rate must be 80–300 words/minute');
  ensure(text(request.voice,100),'Explicit installed voice required');
  ensure(typeof request.source==='string'&&path.isAbsolute(request.source)&&path.extname(request.source).toLowerCase()==='.mp4','Absolute local MP4 source required');
  ensure(typeof request.outputDir==='string'&&path.isAbsolute(request.outputDir),'Absolute new output directory required');
  if(request.binding!==undefined)ensure(object(request.binding)&&JSON.stringify(request.binding).length<=4096,'Invalid binding');
  // Snapshot caller data before any async boundary so a reused host object cannot redirect output mid-export.
  request={...request,segments,binding:request.binding===undefined?undefined:structuredClone(request.binding)};
  check(signal);
  const source=await realpath(request.source),stat=await lstat(request.source);
  ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=2000000000,'Expected regular MP4, at most 2GB');
  const parent=path.dirname(request.outputDir);ensure(await realpath(parent)===parent,'Output parent must be a real existing directory, without symlink components');
  const tools=await discoverTools({signal});ensure(tools.voices.includes(request.voice),'Voice is not installed');
  const sourceInfo=await probe(tools,source,signal);localMedia(sourceInfo);
  const seconds=duration(sourceInfo);ensure(seconds<=180.1,'Source exceeds 180-second limit');
  ensure(segments.at(-1).endMs<=Math.floor(seconds*1000),'Segment ends beyond source duration');
  const sourceHash=await hash(source);check(signal);
  // Exclusive creation is also the cross-process lease. Existing/partial exports are never replayed or overwritten.
  await mkdir(request.outputDir,{mode:0o700});
  const out=name=>path.join(request.outputDir,name),measured=[];
  const base={schemaVersion:1,source,sourceSha256:sourceHash,binding:request.binding??null,voice:request.voice,rate,segments,tools,rawDurationSeconds:seconds};
  try {
    await writeJSON(out('request.json'),base);
    await writeFile(out('captions.srt'),toSRT(segments),{flag:'wx'});
    for(let i=0;i<segments.length;i++) {
      check(signal);const s=segments[i],stem=`speech-${String(i+1).padStart(2,'0')}`;
      await writeFile(out(`${stem}.txt`),s.text,{flag:'wx'});
      await runProcess(tools.say,['-v',request.voice,'-r',String(rate),'-f',out(`${stem}.txt`),'-o',out(`${stem}.aiff`)],{signal,timeoutMs:45000});
      const speechInfo=await probe(tools,out(`${stem}.aiff`),signal),speechSeconds=duration(speechInfo);
      const m={id:s.id,file:out(`${stem}.aiff`),durationSeconds:speechSeconds,availableMs:s.endMs-s.startMs};measured.push(m);
      assertSpeechFits(s,speechSeconds);
    }
    check(signal);
    const common=['-hide_banner','-loglevel','error','-nostdin','-n','-threads','1','-filter_complex_threads','1'];
    const speechInputs=measured.flatMap(m=>['-protocol_whitelist','file','-i',m.file]);
    const delayed=segments.map((s,i)=>`[${i+1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${s.startMs}:all=1[d${i}]`);
    const labels=segments.map((_,i)=>`[d${i}]`).join('');
    const graph=[...delayed,`[0:a]${labels}amix=inputs=${segments.length+1}:duration=first:normalize=0[narration]`].join(';');
    await runProcess(tools.ffmpeg,[...common,'-f','lavfi','-i',`anullsrc=r=48000:cl=stereo:d=${seconds}`,...speechInputs,'-filter_complex',graph,'-map','[narration]','-c:a','pcm_s16le',out('narration.wav')],{signal});
    const finalInfo=await composeFilm({tools,source,sourceInfo,seconds,sourceHash,outputDir:request.outputDir,signal});
    const result={...base,status:'completed',measured,output:out('film.mp4'),captions:out('captions.srt'),narration:out('narration.wav'),outputSha256:await hash(out('film.mp4')),outputProbe:finalInfo};
    check(signal);await writeJSON(out('result.json'),result);return result;
  }catch(error){
    // Retain material and explicit failure for review. Never turn a partial or cancelled export into success.
    try{await writeJSON(out('failure.json'),{status:'failed',error:String(error.message),measured,source,sourceSha256:sourceHash});}catch{}
    throw error;
  }
}
