import {spawn} from 'node:child_process';

// Private executable boundary: callers of index.mjs cannot provide commands or filters.
export function runProcess(file,args,{signal,timeoutMs=120000,maxBytes=524288}={}) {
  if(signal?.aborted)return Promise.reject(new Error('Cancelled before process start'));
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',stderr='',bytes=0,failure,escalation;
    const stop=message=>{if(failure)return;failure=new Error(message);child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),1000);escalation.unref();};
    const abort=()=>stop('Cancelled');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop('Process timed out'),timeoutMs);timer.unref();
    const consume=which=>chunk=>{bytes+=chunk.length;if(bytes>maxBytes){stop('Process output limit exceeded');return;}if(which==='out')stdout+=chunk;else stderr+=chunk;};
    child.stdout.on('data',consume('out'));child.stderr.on('data',consume('err'));
    child.once('error',e=>{failure=e;});
    child.once('close',(code,exitSignal)=>{
      clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener('abort',abort);
      if(failure||signal?.aborted)return reject(failure||new Error('Cancelled'));
      if(code!==0)return reject(new Error(`${file} exited ${code??exitSignal}: ${stderr.slice(-4000)}`));
      resolve({stdout,stderr});
    });
    // Close the addEventListener race without launching another process.
    if(signal?.aborted)abort();
  });
}
