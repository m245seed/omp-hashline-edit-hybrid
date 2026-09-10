import { performance } from "perf_hooks";
import { AnchorAllocator } from "../src/anchors/allocator.ts";
import { fingerprintHexes } from "../src/anchors/fingerprints.ts";
import { reconcileState } from "../src/anchors/reconcile.ts";
import { alignSequences } from "../src/anchors/sequence-map.ts";
import { splitTextLines, joinTextLines } from "../src/document/lines.ts";
import { looksBinary, decodeUtf8Strict } from "../src/document/encoding.ts";
import { detectBoundaryDuplication } from "../src/render/warnings.ts";
import { applyOutputBudget } from "../src/render/engine.ts";
import { applyTransaction } from "../src/mutation/apply.ts";
import { reconcileServed, serveLines, resetServed } from "../src/served/ledger.ts";
import { checkRangeServed } from "../src/served/authorize.ts";
import { withStateDir, makeTmpDir } from "../test/support/env.ts";
import { writeFileAt } from "../test/support/tools.ts";
import { loadAnchoredFile } from "../src/mutation/transaction.ts";
import { buildReadToolDef } from "../src/tools/read.ts";
import { buildEditToolDef } from "../src/tools/edit.ts";
import { buildUndoToolDef } from "../src/tools/undo.ts";
import { buildGrepToolDef } from "../src/tools/grep.ts";
import { runTool } from "../test/support/tools.ts";
import { loadStore, resetStoreForTests, requireStore } from "../src/state/database.ts";
import { resolveTarget } from "../src/filesystem/resolve-target.ts";
import { listPendingTransactions } from "../src/state/transaction-journal.ts";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";

function fmt(n:number){ return n < 1 ? n.toFixed(2)+' ms' : n < 100 ? n.toFixed(1)+' ms' : Math.round(n)+' ms'; }
function bench(name:string, fn:()=>void, iters=3){
  for(let i=0;i<1;i++) fn();
  const times:number[]=[];
  for(let i=0;i<iters;i++){ const t0=performance.now(); fn(); times.push(performance.now()-t0); }
  const avg=times.reduce((a,b)=>a+b,0)/times.length;
  console.log(`  ${name.padEnd(32)} ${fmt(avg)}  (min ${fmt(Math.min(...times))})`);
  return avg;
}
async function benchAsync(name:string, fn:()=>Promise<unknown>, iters=3){
  for(let i=0;i<1;i++) await fn();
  const t:number[]=[]; for(let i=0;i<iters;i++){ const s=performance.now(); await fn(); t.push(performance.now()-s); }
  const avg=t.reduce((a,b)=>a+b,0)/t.length; console.log(`  ${name.padEnd(32)} ${fmt(avg)} (min ${fmt(Math.min(...t))})`); return avg;
}

for(const N of [1_000, 10_000]){
  console.log(`\n## N=${N}`);
  const texts = Array.from({length:N},(_,i)=>`line ${i.toString().padStart(6,"0")} `+"x".repeat(24));
  const textsRep = Array.from({length:N},(_,i)=> i%7===0 ? `u ${i} ${Math.random()}` : "}");
  let r;
  r=bench(`anchor alloc`, ()=>{ const a=new AnchorAllocator(new Set(),new Set()); for(const t of texts) a.allocate(t); });
  r=bench(`anchor alloc rep`, ()=>{ const a=new AnchorAllocator(new Set(),new Set()); for(const t of textsRep) a.allocate(t); });
  r=bench(`fingerprint`, ()=> fingerprintHexes(texts));
  console.log(`    fingerprint rate ${(N/(r/1000)).toFixed(0)} lines/s`);
  const docText=texts.join("\n");
  const lines=splitTextLines(docText);
  r=bench(`split`, ()=> splitTextLines(docText));
  r=bench(`join`, ()=> joinTextLines(lines));
  const oldHex=fingerprintHexes(texts);
  const newTexts=texts.slice(); for(let i=0;i<N*0.01;i++) newTexts[Math.floor(Math.random()*N)]=`mut ${i}`;
  const newHex=fingerprintHexes(newTexts);
  const tHex=bench(`align hex`, ()=> alignSequences(oldHex, newHex),2);
  const map=new Map<string,number>(); let nid=1; const toId=(h:string)=>{ let id=map.get(h); if(!id){id=nid++; map.set(h,id);} return id;};
  const oldIds=oldHex.map(toId); const newIds=newHex.map(toId);
  const tInt=bench(`align int`, ()=> alignSequences(oldIds,newIds),2);
  console.log(`    speedup ${(tHex/tInt).toFixed(2)}x`);
  const fakeAnchors=(()=>{ const a=new AnchorAllocator(new Set(),new Set()); return texts.map(t=>a.allocate(t));})();
  const newTexts2=texts.slice(); for(let i=0;i<N*0.005;i++) newTexts2.splice(Math.floor(Math.random()*newTexts2.length),1,`ins ${i}`);
  while(newTexts2.length<N) newTexts2.push(`pad ${newTexts2.length}`);
  while(newTexts2.length>N) newTexts2.pop();
  const newHex2=fingerprintHexes(newTexts2);
  bench(`reconcile`, ()=> reconcileState({anchors:fakeAnchors, fingerprints:oldHex}, new Set(), newTexts2, newHex2),2);
  const doc={bom:"", lines};
  const mid=Math.floor(N/2);
  const ops=[{kind:"edit" as const, start:mid, end:mid+4, lines:Array.from({length:5},(_,i)=>`edited ${i}`), requestIndex:0}];
  bench(`applyTransaction`, ()=> applyTransaction(doc,{anchors:fakeAnchors, retired:new Set()},ops),2);
  bench(`boundaryDup 2000x`, ()=>{ for(let i=0;i<2000;i++) detectBoundaryDuplication(Array.from({length:20},(_,k)=>`dup ${k}`), texts.slice(100,120), texts.slice(200,220)); },1);
  const cand=texts.slice(0,Math.min(2000,N)).map(t=>({rendered:`Ab12│${t}`, renderedBytes:t.length+5, servable:{anchor:"Ab12", exactText:t}}));
  bench(`budget 2k`, ()=> applyOutputBudget(cand,256*1024),2);
  resetServed();
  const fakeAnchors3=Array.from({length:N},(_,i)=>`A${String(i).padStart(3,"0")}`.slice(0,4));
  serveLines("/tmp/bench.ts", fakeAnchors3.slice(0,Math.floor(N*0.3)).map((a,i)=>({anchor:a, exactText:texts[i]!})));
  const mapping=alignSequences(texts.slice(0,N-3), texts.slice(0,N-3));
  bench(`ledger reconcile`, ()=> reconcileServed("/tmp/bench.ts", fakeAnchors3, mapping, fakeAnchors3, texts),2);
  bench(`authorize 100`, ()=> checkRangeServed("/tmp/bench.ts", fakeAnchors3, texts, mid-50,mid+50),3);
  const raw=Buffer.from(texts.slice(0,100).join("\n"));
  bench(`looksBinary 2000x`, ()=>{ for(let i=0;i<2000;i++) looksBinary(raw); },1);
  const raw2=Buffer.from("hello 🌍\n".repeat(500));
  bench(`decodeUtf8 2000x`, ()=>{ for(let i=0;i<2000;i++) decodeUtf8Strict(raw2); },1);
}

console.log(`\n## N=50_000 stress (core only)`);
{
  const N=50_000;
  const texts=Array.from({length:N},(_,i)=>`line ${i.toString().padStart(6,"0")} `+"x".repeat(24));
  const t0=performance.now();
  const hex=fingerprintHexes(texts); const t1=performance.now();
  console.log(`  fingerprint 50k:             ${fmt(t1-t0)} ${(N/((t1-t0)/1000)).toFixed(0)} lines/s`);
  const a=new AnchorAllocator(new Set(),new Set());
  const t2=performance.now(); for(const t of texts) a.allocate(t); const t3=performance.now();
  console.log(`  anchor alloc 50k:            ${fmt(t3-t2)}`);
  const oldHex=hex; const newTexts=texts.slice(); for(let i=0;i<500;i++) newTexts[Math.floor(Math.random()*N)]=`mut ${i}`;
  const newHex=fingerprintHexes(newTexts);
  const map=new Map<string,number>(); let nid=1; const toId=(h:string)=>{ let id=map.get(h); if(!id){id=nid++; map.set(h,id);} return id;};
  const oldIds=oldHex.map(toId); const newIds=newHex.map(toId);
  const ta=performance.now(); alignSequences(oldHex,newHex); const tb=performance.now();
  const tc=performance.now(); alignSequences(oldIds,newIds); const td=performance.now();
  console.log(`  align hex 50k:               ${fmt(tb-ta)}  int: ${fmt(td-tc)}  speedup ${((tb-ta)/(td-tc)).toFixed(2)}x`);
}

for(const N of [1_000, 10_000]){
  console.log(`\n## Tool integration N=${N}`);
  const stateDir=withStateDir(); await resetStoreForTests(); await loadStore();
  const proj=makeTmpDir("pi-bench-");
  const texts=Array.from({length:N},(_,i)=>`line ${i.toString().padStart(6,"0")} `+"x".repeat(24));
  writeFileAt(proj,"bench.ts",texts.join("\n"));
  const readTool=buildReadToolDef(); const editTool=buildEditToolDef(); const undoTool=buildUndoToolDef(); const grepTool=buildGrepToolDef();
  await benchAsync(`read`, async()=> await runTool(readTool,{path:"bench.ts", limit:N},proj),3);
  const real=await resolveTarget(join(proj,"bench.ts"));
  const f=await loadAnchoredFile(real,"bench.ts");
  console.log(`  anchors ${f.anchors.length}`);
  await benchAsync(`edit 5 mid`, async()=>{
    await runTool(readTool,{path:"bench.ts", limit:N},proj);
    const f2=await loadAnchoredFile(real,"bench.ts");
    const mid=Math.floor(f2.texts.length/2);
    const r:[string,string]=[f2.anchors[mid]!,f2.anchors[mid+4]!];
    await runTool(editTool,{path:"bench.ts", edits:[{range:r, lines:Array.from({length:5},(_,i)=>`edited ${i}`)}]},proj);
  },2);
  await benchAsync(`undo`, async()=>{
    await runTool(readTool,{path:"bench.ts", limit:N},proj);
    const f3=await loadAnchoredFile(real,"bench.ts");
    const m=Math.floor(f3.texts.length/2);
    const rr:[string,string]=[f3.anchors[m]!,f3.anchors[m]!];
    await runTool(editTool,{path:"bench.ts", edits:[{range:rr, lines:["undo bench"]}]},proj);
    await runTool(undoTool,{path:"bench.ts"},proj);
  },2);
  await benchAsync(`grep limit100`, async()=> await runTool(grepTool,{pattern:"line", path:".", limit:100},proj),2);
  const store=requireStore();
  const avg=bench(`DB listPending`, ()=> listPendingTransactions(),5);
  console.log(`  DB listPending ${(avg*1000).toFixed(1)} µs`);
  rmSync(proj,{recursive:true,force:true}); rmSync(stateDir,{recursive:true,force:true}); await resetStoreForTests();
  const mem=process.memoryUsage();
  console.log(`  heap ${(mem.heapUsed/1024/1024).toFixed(1)} MB rss ${(mem.rss/1024/1024).toFixed(1)} MB`);
}

console.log(`\n# Summary: h32 allocator, int-ID diff, O(N+M) ledger, hoisted authorize, WAL NORMAL, chunked precommit, LRU cap`);
