export const personalExportSections = [
 "info","notes","highlights","replies","ink","bookmarks","progress","uploads",
] as const;
export type PersonalExportSection = typeof personalExportSections[number];
export function validPersonalExportPage(
 raw:unknown,section:PersonalExportSection,roomId:string,offset:number
):raw is {section:PersonalExportSection;room_id:string;offset:number;items:unknown[]} {
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return false;
 const row=raw as Record<string,unknown>;
 return row.section===section&&row.room_id===roomId&&row.offset===offset
   &&Array.isArray(row.items)&&row.items.length<=50;
}
