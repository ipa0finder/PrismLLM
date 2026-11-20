(() => {
'use strict';
const $ = id => document.getElementById(id);
const defaults = {mode:'direct',strategy:'auto-failover',model:'auto',gatewayURL:'',gatewayKey:'',providers:[]};
let state = {...defaults, ...JSON.parse(localStorage.getItem('prism-settings') || '{}')};
let chats = JSON.parse(localStorage.getItem('prism-chats') || '[]');
let current = null, aborter = null;
const native = !!(window.webkit?.messageHandlers?.prism);
const persist = () => localStorage.setItem('prism-settings', JSON.stringify(state));
const saveChats = () => localStorage.setItem('prism-chats', JSON.stringify(chats));
const haptic = () => { try { window.webkit?.messageHandlers?.prism?.postMessage({type:'haptic'}); } catch {} };
const secureStore = async (key, value) => {
  if (native) return new Promise(resolve => {
    const id = 'cb'+Math.random().toString(36).slice(2);
    window[id] = result => { delete window[id]; resolve(result); };
    window.webkit.messageHandlers.prism.postMessage({type:'keychainSet',key,value,callback:id});
  });
  localStorage.setItem('prism-secret-'+key, value); return true;
};
const secureRead = async key => {
  if (native) return new Promise(resolve => {
    const id='cb'+Math.random().toString(36).slice(2);
    window[id]=result=>{delete window[id];resolve(result?.value || '')};
    window.webkit.messageHandlers.prism.postMessage({type:'keychainGet',key,callback:id});
  });
  return localStorage.getItem('prism-secret-'+key)||'';
};
function show(view) {
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  $(view+'View').classList.remove('hidden'); $('drawer').classList.add('hidden');
  if(view==='history') renderHistory(); if(view==='keys') renderProviders();
}
$('menuBtn').onclick=()=> $('drawer').classList.toggle('hidden');
$('closeDrawer').onclick=()=> $('drawer').classList.add('hidden');
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>show(b.dataset.view));
$('modelBtn').onclick=()=>show('settings');
document.querySelectorAll('.suggestions button').forEach(b=>b.onclick=()=>{$('prompt').value=b.textContent; $('prompt').focus()});
function addMessage(role,content) {
  const welcome=document.querySelector('.welcome'); if(welcome) welcome.remove();
  const el=document.createElement('div'); el.className='message '+role; el.textContent=content;
  $('messages').append(el); $('messages').scrollTop=$('messages').scrollHeight; return el;
}
function activeChat() {
  if(!current){current={id:crypto.randomUUID(),title:'New conversation',messages:[],updated:Date.now()};chats.unshift(current);}
  return current;
}
async function requestNative(url, headers, body, onChunk) {
  // Native bridge performs the request to avoid WKWebView CORS restrictions.
  if(!native) {
    const res=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:aborter.signal});
    if(!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,300)}`);
    if(body.stream && res.body) {
      const reader=res.body.getReader(),decoder=new TextDecoder();let buf='';
      while(true){const {value,done}=await reader.read();if(done)break;buf+=decoder.decode(value,{stream:true});const lines=buf.split(/\r?\n/);buf=lines.pop()||'';for(const line of lines)if(line.startsWith('data:')){const d=line.slice(5).trim();if(d==='[DONE]')return;if(d)try{const t=JSON.parse(d).choices?.[0]?.delta?.content;if(t)onChunk(t)}catch{}}}
      return;
    }
    return await res.json();
  }
  return new Promise((resolve,reject)=>{
    const id='net'+Math.random().toString(36).slice(2);
    window[id]=(event)=>{
      if(event.error){delete window[id];reject(new Error(event.error));return;}
      if(event.chunk){onChunk(event.chunk);return;}
      if(event.done){delete window[id];resolve(event.json||{});}
    };
    window.webkit.messageHandlers.prism.postMessage({type:'request',id,url,headers,body});
    aborter.signal.addEventListener('abort',()=>{window.webkit.messageHandlers.prism.postMessage({type:'cancel',id});delete window[id];reject(new DOMException('Aborted','AbortError'));},{once:true});
  });
}
async function send() {
  const text=$('prompt').value.trim(); if(!text||aborter)return;
  $('prompt').value=''; haptic(); const chat=activeChat(); chat.messages.push({role:'user',content:text});
  if(chat.messages.length===1)chat.title=text.slice(0,48);
  addMessage('user',text); const output=addMessage('assistant',''); $('sendBtn').textContent='■';
  aborter=new AbortController();
  try {
    let base, token;
    if(state.mode==='gateway'){base=state.gatewayURL.replace(/\/+$/,'');token=await secureRead('gateway-key');}
    else {
      const p=state.providers[0]; if(!p)throw new Error('Add a provider key in Keys & endpoints first.');
      base=p.baseURL.replace(/\/+$/,'');token=await secureRead('provider:'+p.id);
    }
    if(!base)throw new Error('Configure a valid API base URL in Settings.');
    const headers={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
    const body={model:state.model||'auto',messages:chat.messages,stream:true};
    await requestNative(base+'/chat/completions',headers,body,chunk=>{output.textContent+=chunk;$('messages').scrollTop=$('messages').scrollHeight;});
    chat.messages.push({role:'assistant',content:output.textContent});
  } catch(e) {
    output.textContent=(e.name==='AbortError'?'Generation stopped.':'Request failed: '+e.message);
  } finally {aborter=null;$('sendBtn').textContent='↑';chat.updated=Date.now();saveChats();}
}
$('sendBtn').onclick=()=>{if(aborter){aborter.abort();return;}send();};
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
$('prompt').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,130)+'px';});
function renderHistory(){
  $('historyList').replaceChildren();
  chats.forEach(c=>{const b=document.createElement('button');b.className='suggestions';b.textContent=c.title;b.onclick=()=>{current=c;$('messages').replaceChildren();c.messages.forEach(m=>addMessage(m.role,m.content));show('chat');};$('historyList').append(b);});
}
function renderProviders(){
  $('providerList').replaceChildren();
  state.providers.forEach(p=>{const el=document.createElement('div');el.className='provider';el.textContent=p.name+' · '+p.baseURL;$('providerList').append(el);});
}
$('saveProvider').onclick=async()=>{
  const name=$('keyName').value.trim(),baseURL=$('keyURL').value.trim(),value=$('keyValue').value.trim();
  if(!name||!baseURL||!/^https?:\/\//i.test(baseURL)||!value){alert('Enter a name, valid base URL and API key.');return;}
  const id=crypto.randomUUID();await secureStore('provider:'+id,value);state.providers.push({id,name,baseURL});persist();$('keyValue').value='';renderProviders();alert('Provider saved.');
};
$('saveGateway').onclick=async()=>{
  state.gatewayURL=$('gatewayURL').value.trim();
  const secret=$('gatewayKey').value.trim();
  await secureStore('gateway-key',secret);
  state.gatewayKey=''; persist(); $('gatewayKey').value=''; alert('Gateway settings saved securely.');
};
$('saveSettings').onclick=async()=>{
  state.strategy=$('strategy').value;state.mode=$('mode').value;state.model=$('modelID').value.trim()||'auto';persist();alert('Settings saved.');
};
$('exportBtn').onclick=async()=>{
  const include=confirm('Include API keys in this backup? The exported JSON will contain plaintext credentials.');
  const secrets={};if(include){for(const p of state.providers)secrets[p.id]=await secureRead('provider:'+p.id);secrets.gateway=await secureRead('gateway-key');}
  const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),settings:state,chats,secrets},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='prismllm-backup.json';a.click();URL.revokeObjectURL(a.href);
};
$('importFile').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try{const data=JSON.parse(await file.text());if(data.version!==1||!Array.isArray(data.chats))throw Error('Unsupported backup');
    chats=data.chats;state={...defaults,...data.settings,gatewayKey:''};if(data.secrets){for(const [id,key] of Object.entries(data.secrets))await secureStore(id==='gateway'?'gateway-key':'provider:'+id,key);}
    persist();saveChats();alert('Backup imported.');show('chat');
  }catch(err){alert('Import failed: '+err.message);}
};
$('clearBtn').onclick=()=>{if(confirm('Delete all locally stored conversations?')){chats=[];current=null;saveChats();$('messages').replaceChildren();alert('Conversations deleted.');}};
(async()=>{
  $('strategy').value=state.strategy;$('mode').value=state.mode;$('modelID').value=state.model;
  $('gatewayURL').value=state.gatewayURL;$('gatewayKey').value='';
  renderProviders();
})();
})();
