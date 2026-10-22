/**
 * Responsive V2 reading spreads: mobile shows one protected paragraph page,
 * wide screens may show two consecutive pages. All positions refer to the
 * original immutable chunk indexes, so private notes and server CAS stay safe.
 */
export type ReaderPage = {chunk_index:number;body:string};
export const READER_SPREAD_QUERY="(min-width: 1100px)";
export const READER_MAX_CHUNK=1999;

export function spreadSize(wide:boolean):1|2 { return wide?2:1; }

export function readingPageIndex(
  current:number,direction:-1|1,wide:boolean,
):number {
  const base=Number.isInteger(current) ? Math.max(0,Math.min(READER_MAX_CHUNK,current)):0;
  return Math.max(0,Math.min(READER_MAX_CHUNK,base+direction*spreadSize(wide)));
}

/** Never display a returned unrequested or out-of-order chunk as the next
 * page: adjacent positions are their own independent annotation namespaces.
 */
export function checkedReaderPages(
  data:unknown,start:number,wide:boolean,
):ReaderPage[] {
  if (!Array.isArray(data) || !Number.isInteger(start) ||
      start<0 || start>READER_MAX_CHUNK) return [];
  const pages:ReaderPage[]=[];
  for (let i=0;i<spreadSize(wide) && start+i<=READER_MAX_CHUNK;i++){
    const current=data.find(row=>row && typeof row==="object" &&
      row.chunk_index===start+i && typeof row.body==="string" &&
      Array.from(row.body).length<=3000);
    if (!current) break;
    pages.push({chunk_index:start+i,body:current.body});
  }
  return pages;
}
