#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
const log=v=>appendFileSync(process.env.ACP_FIXTURE_LOG,JSON.stringify(v)+'\n');
const provider=process.env.ACP_FIXTURE_PROVIDER;
log({providerPid:process.pid});
let sessionId=process.env.ACP_FIXTURE_SESSION || 'provider-session';
let mcp, pending=new Map(), serial=0;
let promptId; const clientRequests=new Map();
const ask=(method,params)=>new Promise(resolve=>{const id='provider-request-'+(++serial);clientRequests.set(id,resolve);send({id,method,params});});
const options=[{id:'vendor-model',category:'model',type:'select',options:[{value:'test-model',name:'Test'}]},
 {id:'vendor-effort',category:provider==='cursor'?'thought_level':'reasoning_effort',type:'select',options:[{value:'high',name:'High'}]},
 {id:'fast',category:'model_config',type:'select',options:[{value:'true'},{value:'false'}]}];
const rpc=(method,params)=>new Promise((resolve,reject)=>{
 const id=++serial;pending.set(id,{resolve,reject,method});if(method==='tools/call')log({mcpCallId:id,toolName:params.name});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
async function setup(server){
 if(!server)return;
 const env={...process.env,...Object.fromEntries(server.env.map(e=>[e.name,e.value]))};
 mcp=spawn(server.command,server.args,{env,stdio:['pipe','pipe','inherit']});
 log({mcpPid:mcp.pid});
 createInterface({input:mcp.stdout}).on('line',line=>{
  const v=JSON.parse(line);const p=pending.get(v.id);pending.delete(v.id);if(p?.method==='tools/call')log({mcpReplyId:v.id,isError:v.result?.isError});
  if(v.error)p?.reject(new Error('MCP rejected'));else p?.resolve(v.result);
 });
 mcp.on('exit',()=>{for(const p of pending.values())p.reject(new Error('MCP disconnected'));pending.clear();});
 await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fake',version:'1'}});
 mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const list=await rpc('tools/list',{});log({tools:list.tools.map(t=>t.name)});
}
createInterface({input:process.stdin}).on('line',async line=>{
 let f;try{f=JSON.parse(line);}catch{return;}
 const {method,params={},id}=f;
 if(!method && clientRequests.has(id)){clientRequests.get(id)(f.result);clientRequests.delete(id);return;}
 log({method,...(method==='session/set_config_option'?{configId:params.configId,value:params.value}:{}),...(method==='session/new'||method==='session/load'?{mcpCount:params.mcpServers.length}:{}),...(method==='session/prompt'?{slashShaped:params.prompt[0].text.startsWith('- /')}:{} )});
 try{
 if(method==='initialize'){
  log({cursorCaps:params.clientCapabilities?._meta?.parameterizedModelPicker===true,skillDenied:process.env.OPENCODE_PERMISSION?JSON.parse(process.env.OPENCODE_PERMISSION).skill==='deny':false});
  send({id,result:{protocolVersion:Number(process.env.ACP_FIXTURE_PROTOCOL||1),agentInfo:{name:'fake-'+provider,version:'fixture-1'},agentCapabilities:{loadSession:process.env.ACP_FIXTURE_NO_LOAD!=='1'},authMethods:[]}});
 }else if(method==='session/new'||method==='session/load'){
  if(method==='session/load')sessionId=params.sessionId;
  await setup(params.mcpServers[0]);
  send({id,result:{sessionId:method==='session/load'?(process.env.ACP_FIXTURE_BAD_LOAD==='1'?'wrong':params.sessionId):sessionId,configOptions:options,modes:{currentModeId:'ask',availableModes:[{id:'ask',name:'Ask'},{id:'agent',name:'Full Agent'}]}}});
 }else if(method==='session/set_config_option'){send({id,result:{configOptions:options}});}
 else if(method==='session/set_mode'||method==='authenticate'){send({id,result:{}});}
 else if(method==='session/cancel'){log({cancelled:true});if(process.env.ACP_FIXTURE_LATE==='1')send({id:promptId,result:{stopReason:'end_turn'}});}
 else if(method==='session/prompt'){
  promptId=id;
  if(process.env.ACP_FIXTURE_PERMISSION==='1') {
   for(const path of ['src/example.rs','../../outside']) {
    const result=await ask('session/request_permission',{sessionId,toolCall:{locations:[{path}]},options:[{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]});
    log({permission:path.startsWith('src')?'inside':'outside',decision:result.outcome.optionId});
   }
   if(provider==='cursor') {log({extension:'question',result:await ask('cursor/ask_question',{sessionId})});log({extension:'plan',result:await ask('cursor/create_plan',{sessionId})});}
  }
  if(process.env.ACP_FIXTURE_HANG==='1')return;
  if(mcp){
   const names=(await rpc('tools/list',{})).tools.map(t=>t.name);
   const count=Number(process.env.ACP_FIXTURE_TOOLS||2);
   const requests=Array.from({length:count},(_,i)=>rpc('tools/call',{name:names[i%names.length],arguments:{v:'private-value'}}));
   for(let i=0;i<requests.length;i++) {const result=await requests[i];log({toolReply:i+1,isError:result.isError,result:JSON.parse(result.content[0].text)});}
  }
  if(process.env.ACP_FIXTURE_TRACE==='1'){
   // Level 1 tool trace: one native shell call reported through ACP tool_call / tool_call_update.
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'fixture-call',title:provider==='cursor'?'`echo trace-ok`':'bash',kind:'execute',status:'pending',...(provider==='cursor'?{}:{rawInput:{command:'echo trace-ok'}})}}});
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'fixture-call',status:'completed',...(provider==='cursor'?{content:[{type:'content',content:{type:'text',text:'trace-ok'}}]}:{rawOutput:{output:'trace-ok',metadata:{exit:0}}})}}});
  }
  send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello ACP'}}}});
  send({id,result:{stopReason:'end_turn',usage:{inputTokens:4,private:'credential'}}});
 }
 }catch{send({id,error:{code:-32603,message:'fixture transport failure'}});}
});
