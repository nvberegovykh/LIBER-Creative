import { bookFilename } from './book-structure.js?v=20260914r193-books1';
let loading;
export function loadSpreadsheetEngine() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!loading) loading = new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    const timer=setTimeout(()=>{script.remove();loading=null;reject(new Error('Excel export took too long to load. Retry or use CSV.'));},20000);
    script.onload=()=>{clearTimeout(timer);if(window.XLSX)resolve(window.XLSX);else{loading=null;reject(new Error('Excel export could not load. Retry or use CSV.'));}};
    script.onerror=()=>{clearTimeout(timer);script.remove();loading=null;reject(new Error('Excel export could not load. Retry or use CSV.'));};
    document.head.append(script);
  });
  return loading;
}
export function createBookWorkbook(XLSX, { project, divisions, date = new Date() }) {
  const workbook=XLSX.utils.book_new(),stamp=date.toISOString().slice(0,10),names=new Set(['summary']);
  const sheetName=title=>{const stem=String(title||'Division').replace(/[\[\]:*?/\\]/g,' ').replace(/^'+|'+$/g,'').trim().slice(0,31)||'Division';let name=stem,index=2;while(names.has(name.toLocaleLowerCase())||names.has(name)){const suffix=` (${index++})`;name=stem.slice(0,31-suffix.length)+suffix;}names.add(name.toLocaleLowerCase());return name;};
  const summary=[['Design Book',String(project||'Project')],['Export date',stamp],[],['Division','Worksheet','Positions','Approved']];
  const pending=[];
  for(const division of divisions){
    const name=sheetName(division.title),items=division.items||[];
    summary.push([String(division.title||''),name,items.length,items.filter(item=>item.status==='Approved').length]);
    const rows=[['Project',String(project||'Project')],['Division',String(division.title||'')],['Export date',stamp],[],['Position','Location','Status','Description','Product link','Image links','Position ID']];
    for(const item of items){const images=(item.images||[]).map(image=>image.url).filter(Boolean).join('\n');const values=[item.label,(item.revit?.levels||[]).join('; '),item.status||'Not Selected',item.description||'',item.source||'',images,item.id].map(value=>String(value??''));if(values.some(value=>value.length>32767))throw new Error('A position exceeds Excel’s cell text limit. Use CSV to preserve the complete text.');rows.push(values);}
    const sheet=XLSX.utils.aoa_to_sheet(rows);sheet['!cols']=[{wch:32},{wch:24},{wch:18},{wch:75},{wch:60},{wch:60},{wch:40}];
    sheet['!autofilter']={ref:`A5:G${Math.max(5,rows.length)}`};
    for(let i=0;i<items.length;i++){const url=safeLink(items[i].source);if(url)sheet[`E${i+6}`].l={Target:url,Tooltip:'Open source product'};}
    pending.push([sheet,name]);
  }
  const first=XLSX.utils.aoa_to_sheet(summary);first['!cols']=[{wch:34},{wch:34},{wch:16},{wch:16}];
  pending.forEach(([,name],index)=>{first[`B${index+5}`].l={Target:`#'${name.replace(/'/g,"''")}'!A1`,Tooltip:'Open division'};});
  XLSX.utils.book_append_sheet(workbook,first,'Summary');pending.forEach(([sheet,name])=>XLSX.utils.book_append_sheet(workbook,sheet,name));
  workbook.Props={Title:bookFilename('Design Book',project,date),Subject:'Saved Design Book selections by division',Author:'LIBER REVEX',CreatedDate:date};
  return workbook;
}
function safeLink(value){try{const url=new URL(String(value||''));return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}}
