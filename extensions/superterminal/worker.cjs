'use strict';
const protocol=require('./protocol.json');
exports.createPlugin=async()=>({
  async invoke(method,input,context){
    if(!Object.hasOwn(protocol,method))throw new Error('Unsupported terminal command');
    if(method!=='commands')return context.call('terminal.'+method,input);
    const {query,status,...request}=input;
    const search=value=>value.normalize('NFKC').toLocaleLowerCase();
    const history=await context.call('terminal.commands',request),needle=query&&search(query.trim());
    return {...history,records:history.records.filter(record=>(!status||record.status===status)&&(!needle||search(record.command+'\n'+record.output).includes(needle)))};
  },
  async close(){}
});
