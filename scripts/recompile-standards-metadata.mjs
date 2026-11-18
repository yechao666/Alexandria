#!/usr/bin/env node
const BASE=process.env.ALEXANDRIA_URL||'http://127.0.0.1:4520'; const LIB='lib_a316905460c5420a99c0';
const login=async()=>{const r=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'lin@alex.dev',password:'alex-demo'})});return r.headers.get('set-cookie').split(';')[0];};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const main=async()=>{const cookie=await login(); const data=await (await fetch(`${BASE}/api/sources?library=${LIB}&limit=2000`,{headers:{cookie}})).json(); const sources=(data.sources||[]).filter(s=>s.filename!=='standard-fulltext.pdf'); let n=0; for(const s of sources){try{const r=await fetch(`${BASE}/api/sources/${s.id}/reprocess?compiler=rule`,{method:'POST',headers:{cookie}}); if(r.ok)n++;}catch{} await sleep(40);} console.log(`queued ${n}/${sources.length} metadata standards`);};
main();
