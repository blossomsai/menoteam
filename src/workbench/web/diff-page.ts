export type DiffRow = { text:string; type:'context'|'add'|'remove'|'meta'; oldLine?:number; newLine?:number; continuation?:boolean; terminated?:boolean };
type OpenLine = Omit<DiffRow,'text'> & { header?:string };
export type DiffPageState = { oldLine:number; newLine:number; oldRemaining:number; newRemaining:number; inHunk:boolean; line?:OpenLine };
export const DIFF_FRAGMENT_CHARS=4096,DIFF_VISIBLE_CHARS=64*1024,DIFF_VISIBLE_ROWS=1024;
export const initialDiffPageState=():DiffPageState=>({oldLine:0,newLine:0,oldRemaining:0,newRemaining:0,inHunk:false});

// Keep only hunk/line identity across pages. Source text stays in its bounded byte page.
export function parseDiffPage(text:string,before:DiffPageState,viewOffset=0){
  const state:DiffPageState={...before,...(before.line?{line:{...before.line}}:{})};
  const rows:DiffRow[]=[];let visibleChars=0,truncated=false,nextOffset:number|null=null;
  const emit=(fragment:string,line:OpenLine,continued:boolean,sourceStart:number,newline:boolean)=>{
    if(truncated||viewOffset>sourceStart+fragment.length||viewOffset===sourceStart+fragment.length&&!newline)return;
    let offset=Math.max(0,viewOffset-sourceStart);
    do {
      if(rows.length>=DIFF_VISIBLE_ROWS||visibleChars>=DIFF_VISIBLE_CHARS){truncated=true;nextOffset=sourceStart+offset;break;}
      let end=Math.min(fragment.length,offset+DIFF_FRAGMENT_CHARS,offset+DIFF_VISIBLE_CHARS-visibleChars);
      if(end<fragment.length&&end>offset&&/[\uD800-\uDBFF]/u.test(fragment[end-1]!))end--;
      if(end===offset&&offset<fragment.length){truncated=true;nextOffset=sourceStart+offset;break;}
      rows.push({text:fragment.slice(offset,end),type:line.type,oldLine:line.oldLine,newLine:line.newLine,continuation:continued||offset>0,terminated:end===fragment.length&&newline});
      visibleChars+=end-offset;offset=end;
    }while(offset<fragment.length);
  };
  let start=0;
  while(start<text.length){
    const newline=text.indexOf('\n',start),end=newline<0?text.length:newline,fragment=text.slice(start,end),continued=!!state.line;
    if(!state.line){
      const type=state.inHunk?(fragment[0]==='+'?'add':fragment[0]==='-'?'remove':fragment[0]===' '?'context':'meta'):'meta';
      state.line={type,...(type==='remove'||type==='context'?{oldLine:state.oldLine}:{}),...(type==='add'||type==='context'?{newLine:state.newLine}:{}),...(fragment.startsWith('@')?{header:''}:{})};
    }
    const line=state.line;
    if(line.header!==undefined)line.header=(line.header+fragment).slice(0,512);
    emit(fragment,line,continued,start,newline>=0);
    if(newline<0)break;
    if(line.header!==undefined){
      const hunk=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line.header);
      if(hunk){state.oldLine=Number(hunk[1]);state.newLine=Number(hunk[3]);state.oldRemaining=Number(hunk[2]??1);state.newRemaining=Number(hunk[4]??1);state.inHunk=state.oldRemaining>0||state.newRemaining>0;}
    }else {
      if(line.oldLine!==undefined){state.oldLine++;state.oldRemaining--;}
      if(line.newLine!==undefined){state.newLine++;state.newRemaining--;}
      if(state.oldRemaining<=0&&state.newRemaining<=0)state.inHunk=false;
    }
    delete state.line;start=newline+1;
  }
  return {rows,state,truncated,nextOffset,continues:!!state.line};
}

export function historicalDiffRows(hunks:unknown){
  const rows:DiffRow[]=[];let chars=0,truncated=false;
  const emit=(row:DiffRow)=>{if(rows.length>=DIFF_VISIBLE_ROWS||chars>=DIFF_VISIBLE_CHARS){truncated=true;return;}let end=Math.min(row.text.length,DIFF_FRAGMENT_CHARS,DIFF_VISIBLE_CHARS-chars);if(end<row.text.length&&end>0&&/[\uD800-\uDBFF]/u.test(row.text[end-1]!))end--;const text=row.text.slice(0,end);truncated ||=text.length<row.text.length;chars+=text.length;rows.push({...row,text});};
  if(Array.isArray(hunks))for(const hunk of hunks){
    if(!hunk||typeof hunk!=='object')continue;
    if(typeof hunk.header==='string')emit({text:hunk.header,type:'meta'});
    if(Array.isArray(hunk.lines))for(const line of hunk.lines){
      if(!line||typeof line!=='object'||typeof line.text!=='string')continue;
      const type:DiffRow['type']=['add','remove','context'].includes(line.type)?line.type:'meta';
      emit({text:(type==='add'?'+':type==='remove'?'-':type==='context'?' ':'')+line.text,type,...(Number.isSafeInteger(line.oldLine)?{oldLine:line.oldLine}:{}),...(Number.isSafeInteger(line.newLine)?{newLine:line.newLine}:{})});
      if(truncated&&(rows.length>=DIFF_VISIBLE_ROWS||chars>=DIFF_VISIBLE_CHARS))break;
    }
    if(truncated&&(rows.length>=DIFF_VISIBLE_ROWS||chars>=DIFF_VISIBLE_CHARS))break;
  }
  return {rows,truncated};
}
