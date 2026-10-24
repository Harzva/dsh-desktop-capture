'use strict';
// Only data and scoped host operation requests cross this boundary. No Electron
// objects, approved plans, source paths, output paths or credentials are sent here.
exports.createPlugin=async()=>({
  async invoke(method,input,context){
    if(!['applications','screenshot','record','demo-prepare','voices','narrate'].includes(method))throw new Error('Unknown capture method');
    if(method!=='applications')return context.call('capture.'+method,input);
    const search=value=>value.normalize('NFKC').toLocaleLowerCase();
    const result=await context.call('capture.applications',{}),query=input.query&&search(input.query.trim());
    return {...result,applications:result.applications.filter(app=>!query||search(app.name+' '+app.windowTitle).includes(query))};
  },
  async close(){}
});
