import { expect,it } from 'vitest';
import { DIFF_FRAGMENT_CHARS,DIFF_VISIBLE_CHARS,DIFF_VISIBLE_ROWS,historicalDiffRows,initialDiffPageState,parseDiffPage } from '../src/workbench/web/diff-page';

it('distinguishes file headers from +++/--- content inside hunks across byte pages',()=>{
  const first=parseDiffPage('--- a/file\n+++ b/file\n@@ -7,2 +9,2 @@\n---removed\n+',initialDiffPageState());
  expect(first.rows[0]).toMatchObject({type:'meta'});expect(first.rows[1]).toMatchObject({type:'meta'});
  expect(first.rows.find(row=>row.text==='---removed')).toMatchObject({type:'remove',oldLine:7});
  expect(first.state.line).toMatchObject({type:'add',newLine:9});
  const second=parseDiffPage('++added\n context\n--- a/next\n+++ b/next\n',first.state);
  expect(second.rows[0]).toMatchObject({text:'++added',type:'add',newLine:9,continuation:true});
  expect(second.rows[1]).toMatchObject({type:'context',oldLine:8,newLine:10});
  expect(second.rows[2]).toMatchObject({text:'--- a/next',type:'meta'});expect(second.rows[3]).toMatchObject({type:'meta'});
});

it('continues a split hunk header without assigning invented numbers',()=>{
  const first=parseDiffPage('@@ -40,1 +',initialDiffPageState());
  const second=parseDiffPage('50,2 @@\n-old\n+new\n+extra\n',first.state);
  expect(second.rows.filter(row=>row.type!=='meta')).toMatchObject([{type:'remove',oldLine:40},{type:'add',newLine:50},{type:'add',newLine:51}]);
  expect(second.state.inHunk).toBe(false);
});

it('keeps 60 MiB long-line state constant-sized and caps rendered fragments while preserving line identity',()=>{
  let state=parseDiffPage('@@ -1 +1,2 @@\n-old\n+',initialDiffPageState()).state;
  const page='x'.repeat(256*1024);
  for(let index=0;index<240;index++){
    const parsed=parseDiffPage(page,state);state=parsed.state;
    expect(JSON.stringify(state).length).toBeLessThan(1024);expect(parsed.truncated).toBe(true);expect(parsed.continues).toBe(true);
    expect(parsed.rows.length).toBeLessThanOrEqual(DIFF_VISIBLE_ROWS);expect(parsed.rows.reduce((sum,row)=>sum+row.text.length,0)).toBeLessThanOrEqual(DIFF_VISIBLE_CHARS);
    expect(parsed.rows.every(row=>row.text.length<=DIFF_FRAGMENT_CHARS&&row.type==='add'&&row.newLine===1&&row.continuation)).toBe(true);
  }
  const final=parseDiffPage('\n+after\n',state);
  expect(final.rows.find(row=>row.text==='+after')).toMatchObject({type:'add',newLine:2});expect(final.state.inHunk).toBe(false);
});

it('keeps Unicode intact at fragment and historical-preview limits',()=>{
  const line='+'+'x'.repeat(4094)+'🙂雪';
  const parsed=parseDiffPage(`@@ -0,0 +1 @@\n${line}\n`,initialDiffPageState());
  expect(parsed.rows.filter(row=>row.type==='add').map(row=>row.text).join('')).toBe(line);
  const historical=historicalDiffRows([{lines:[{type:'add',newLine:1,text:line.slice(1)}]}]);
  expect(historical.truncated).toBe(true);expect(historical.rows[0]?.text).toBe(line.slice(0,4095));
});

it('reads every fragment beyond both display limits using lossless within-page portions',()=>{
  const source='@@ -0,0 +1,1801 @@\n'+Array.from({length:1800},(_,i)=>`+line ${i} 雪\n`).join('')+'+'+'x'.repeat(4094)+'🙂'+'雪🙂'.repeat(22_000)+'\n';
  expect(Buffer.byteLength(source)).toBeLessThan(256*1024);const before=initialDiffPageState();let offset=0,reconstructed='',views=0;
  do{
    const parsed=parseDiffPage(source,before,offset);expect(parsed.rows.length).toBeLessThanOrEqual(DIFF_VISIBLE_ROWS);expect(parsed.rows.reduce((n,row)=>n+row.text.length,0)).toBeLessThanOrEqual(DIFF_VISIBLE_CHARS);expect(parsed.rows.every(row=>row.text.length<=DIFF_FRAGMENT_CHARS)).toBe(true);
    reconstructed+=parsed.rows.map(row=>row.text+(row.terminated?'\n':'')).join('');views++;expect(parsed.state.newLine).toBe(1802);expect(parsed.state.inHunk).toBe(false);
    if(parsed.nextOffset===null)break;expect(parsed.nextOffset).toBeGreaterThan(offset);offset=parsed.nextOffset;expect(views).toBeLessThan(20);
  }while(true);
  expect(views).toBeGreaterThan(2);expect(reconstructed).toBe(source);
});

it('reads long-line portions and then preserves the same line identity at the next server-page boundary',()=>{
  const before=parseDiffPage('@@ -0,0 +1,2 @@\n',initialDiffPageState()).state,source='+'+'🙂'.repeat(45_000);let offset=0,joined='';
  do{const view=parseDiffPage(source,before,offset);expect(view.rows.every(row=>row.type==='add'&&row.newLine===1)).toBe(true);joined+=view.rows.map(row=>row.text).join('');if(view.nextOffset===null)break;expect(view.nextOffset).toBeGreaterThan(offset);offset=view.nextOffset;}while(true);
  expect(joined).toBe(source);const endState=parseDiffPage(source,before).state,next=parseDiffPage('tail\n+after\n',endState);
  expect(next.rows[0]).toMatchObject({text:'tail',type:'add',newLine:1,continuation:true});expect(next.rows[1]).toMatchObject({text:'+after',type:'add',newLine:2});
});
