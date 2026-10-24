import {exportNarration,discoverTools} from '../demo/narration/index.mjs';
// Single host-owned job per physical helper. This entry is never imported into
// Electron. The host retains publication authority and validates returned files.
let input='',bytes=0;
try {
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>262144)throw new Error('Input limit');input+=chunk;}
  const request=JSON.parse(input);
  if(!request||request.schema!==1||Object.keys(request).some(k=>!['schema','operation','request'].includes(k)))throw new Error('Invalid host request');
  let result;
  if(request.operation==='voices'&&request.request===null){
    const tools=await discoverTools();result={voices:tools.voices,ffmpegVersion:tools.ffmpegVersion,ffprobeVersion:tools.ffprobeVersion};
  } else if(request.operation==='narrate')result=await exportNarration(request.request);
  else throw new Error('Invalid host operation');
  const output=JSON.stringify({ok:true,result});if(Buffer.byteLength(output)>524288)throw new Error('Output limit');process.stdout.write(output);
}catch{
  // Raw executable paths or subprocess diagnostics are not published over IPC.
  process.stderr.write('Narration helper failed\n');process.exitCode=1;
}
