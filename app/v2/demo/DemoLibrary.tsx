"use client";

import {useCallback,useEffect,useLayoutEffect,useRef,useState,type ChangeEvent,type CSSProperties,type FormEvent,type PointerEvent} from "react";
import {decodeTxt,prepareTxt} from "@/lib/v2/txt";
import {prepareEpub} from "@/lib/v2/epub";
import {preparePdf} from "@/lib/v2/pdf";

type Chapter = {
  name: string;
  kicker: string;
  paragraphs: string[];
  marked: string;
  companionThought: string;
};
type DemoBook = {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  kind: string;
  edition: string;
  color: string;
  initials: string;
  chapters: Chapter[];
  /** Only source-provided, verified navigation entries belong here. */
  toc?: {title:string;chapterIndex:number}[];
  imported?: boolean;
};
type DemoNote = {
  id: string;
  bookId: string;
  chapterIndex: number;
  quote: string;
  content: string;
  author: "我" | "共读伙伴";
  replies?: {id:string;content:string}[];
};
type StrokeAnchor={paragraphIndex:number;start:number;end:number;quote:string;sourceBounds:{x:number;y:number;width:number;height:number}};
type Stroke={id:string;bookId:string;chapterIndex:number;page?:number;points:{x:number;y:number}[];anchor?:StrokeAnchor};
type TextRange={paragraphIndex:number;start:number;end:number};
type Selection={quote:string;chapterIndex:number;ranges:TextRange[]};
/** `quote` is retained for v1 local-storage compatibility. New markings use text ranges. */
type Marking={id:string;bookId:string;chapterIndex:number;quote:string;ranges?:TextRange[]};
type StrokeChange={kind:"add"|"remove";strokes:Stroke[]};
const DEMO_STORAGE_KEY="reading-v2-offline-ui-demo-1";
const MAX_DEMO_STATE=480000;
const MAX_IMPORT_CHARS=120000;
const MAX_IMPORTED_BOOKS=5;

function textOffsetIn(container:HTMLElement,node:Node,offset:number){
  const range=document.createRange();
  range.setStart(container,0);range.setEnd(node,offset);
  return range.toString().length;
}
function strokeDistance(points:{x:number;y:number}[],point:{x:number;y:number}){
  if(!points.length)return Number.POSITIVE_INFINITY;
  let closest=Math.hypot(points[0].x-point.x,points[0].y-point.y);
  for(let index=1;index<points.length;index++){
    const start=points[index-1],end=points[index];
    const dx=end.x-start.x,dy=end.y-start.y;
    const t=Math.max(0,Math.min(1,((point.x-start.x)*dx+(point.y-start.y)*dy)/(dx*dx+dy*dy||1)));
    closest=Math.min(closest,Math.hypot(point.x-(start.x+dx*t),point.y-(start.y+dy*t)));
  }
  return closest;
}
function clampUnit(value:number){return Math.min(1,Math.max(0,value));}
function rangeBoundary(container:HTMLElement,offset:number){
  const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
  let node=walker.nextNode();
  let remaining=Math.max(0,offset);
  let last:Node|null=null;
  while(node){
    last=node;
    const length=node.textContent?.length??0;
    if(remaining<=length)return {node,offset:remaining};
    remaining-=length;node=walker.nextNode();
  }
  return last?{node:last,offset:last.textContent?.length??0}:null;
}
function textRangeAtOffsets(container:HTMLElement,start:number,end:number){
  const from=rangeBoundary(container,start),to=rangeBoundary(container,end);
  if(!from||!to)return null;
  const range=document.createRange();
  range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);
  return range;
}
function rectUnion(rects:DOMRect[]){
  if(!rects.length)return null;
  return {
    left:Math.min(...rects.map(rect=>rect.left)),
    top:Math.min(...rects.map(rect=>rect.top)),
    right:Math.max(...rects.map(rect=>rect.right)),
    bottom:Math.max(...rects.map(rect=>rect.bottom)),
  };
}
function rectsOverlap(a:{left:number;top:number;right:number;bottom:number},b:{left:number;top:number;right:number;bottom:number}){
  return a.right>b.left&&a.left<b.right&&a.bottom>b.top&&a.top<b.bottom;
}
function chapterSourceLength(chapter:Chapter){
  // Keep a stable source-space coordinate that does not depend on the current
  // page width, font size, or single/double-page presentation.
  return Math.max(1,Array.from(chapter.paragraphs.join("\n\n")).length);
}

const seedBooks: DemoBook[] = [
  {
    id: "rain",
    title: "雨停之前",
    subtitle: "写给慢下来的人",
    author: "共读书房 · 原创演示",
    kind: "小说",
    edition: "DEMO EDITION · 01",
    color: "moss",
    initials: "雨",
    chapters: [
      {
        name: "雨落下来",
        kicker: "第一章 · 01 / 04",
        paragraphs: [
          "入秋以后，城里下了一场很长的雨。它并不急着停，从清晨落到午后，又从午后一直落进黄昏。街上的人越来越少，只有屋檐下的水珠仍旧排着队，安静地往地面坠。",
          "她在那间靠街的旧书房里待了一个下午。桌上摆着一盏灯、一本翻到一半的书，还有两只颜色不同的杯子。另一只杯子里的茶已经凉了，她却没有收走。",
          "有些等待并不需要一个确切的时间。就像窗外的雨，你知道它总会停，但不必在它停下之前做出决定。",
          "天色稍暗时，门边响起很轻的脚步声。她没有回头，只把第二张椅子往灯下挪了挪。"
        ],
        marked: "有些等待并不需要一个确切的时间。",
        companionThought: "读到这里，我想到的不是等待，而是允许一件事暂时没有答案。",
      },
      {
        name: "旧书房",
        kicker: "第二章 · 02 / 04",
        paragraphs: [
          "这间屋子原来是一家照相馆。墙上还留着上一任主人钉画框的痕迹，细小的圆孔排成不太整齐的两行，像人说话时偶尔省略的句号。",
          "她喜欢早一点来，把窗推开一条窄缝，让街上的声音进来。电车停靠、报纸翻动、有人笑着道别。声音彼此重叠，却从来不要求她参加。",
          "书架最底层有一个不起眼的空格，刚好能放下两本正在读的书。她后来才发现，原来有人一直把那个位置留给她。",
          "比起一句郑重的承诺，她更相信那些被人反复保留下来的小小位置。"
        ],
        marked: "原来有人一直把那个位置留给她。",
        companionThought: "一种很节制的温柔，不要求对方立刻回应。",
      },
      {
        name: "各自的页码",
        kicker: "第三章 · 03 / 04",
        paragraphs: [
          "他们读同一本书，却总不在同一页。她爱在边缘写下疑问，他习惯先读完，再回头看那些折起的纸角。",
          "起初，她觉得这很奇怪。一起阅读，难道不应该走在同一个位置吗？直到某个晚上，她偶然看见他的批注，才发现他早就读过那段让她久久停留的文字。",
          "靠近一个人，不必剥夺彼此的速度。两个人可以在不同的页码里生活，也可以在同一句话旁重新相遇。",
          "她把书合上，第一次觉得那张空着的椅子不是等待，而是一种自由。"
        ],
        marked: "靠近一个人，不必剥夺彼此的速度。",
        companionThought: "我喜欢这个设定：进度独立，感受才会是真实的。",
      },
      {
        name: "天晴之后",
        kicker: "第四章 · 04 / 04",
        paragraphs: [
          "第二天，雨终于停了。楼下的石板路被洗得发亮，树叶上挂着一层薄薄的光。有人推开窗，街道像重新拥有了声音。",
          "她发现桌上多了一张很小的纸条。上面没有约定日期，只写着一句话：读到喜欢的地方，记得告诉我。",
          "于是她拿起笔，在昨天那一页的空白处写下：已经告诉你了。",
          "窗外的云缓慢地往东边走。房间里很亮，两只杯子都盛着温热的茶。"
        ],
        marked: "读到喜欢的地方，记得告诉我。",
        companionThought: "这个结尾刚刚好。关系里最好的邀请，是可以自由回应。",
      }
    ]
  },
  {
    id: "letter",
    title: "未寄出的信",
    subtitle: "一些关于距离的练习",
    author: "共读书房 · 原创演示",
    kind: "随笔",
    edition: "DEMO EDITION · 02",
    color: "wine",
    initials: "信",
    chapters: [
      {
        name: "第一封信",
        kicker: "其一 · 01 / 03",
        paragraphs: [
          "你看见这封信的时候，窗外大概已经很安静了。我写了三遍开头，最后还是决定像平常那样说话：今天过得怎么样？",
          "人们总想把重要的事情说得漂亮一些。可我记得最清楚的，偏偏是那些不够漂亮的时刻：没有赶上的车、忘带的伞、随手递来的一块糖。",
          "我开始明白，亲近不是知道一个人所有的秘密，而是愿意认真对待那些看上去无关紧要的小事。",
          "我没有寄出这封信。不是因为犹豫，而是想多留一晚，看看明天会不会有新的句子。"
        ],
        marked: "亲近不是知道一个人所有的秘密",
        companionThought: "这句好像在提醒我们：保留边界，也可以建立亲密。",
      },
      {
        name: "隔着一座城",
        kicker: "其二 · 02 / 03",
        paragraphs: [
          "一座城的距离，在地图上是一条弯曲的线。真正生活在两端的人却知道，那条线里面还装着起床时间、疲惫、天气，以及各自必须完成的事情。",
          "所以我不再用回复的快慢计算心意。我把要说的话认真写下来，等你有空时再读。",
          "没有同时在线的日子，并不一定是疏远。我们各自赶路，偶尔在同一个词语上停下来，就已经很好。",
          "写到这里，楼下最后一家面包店关门了。街上只剩一盏暖黄色的灯。"
        ],
        marked: "我不再用回复的快慢计算心意。",
        companionThought: "这可能是我最近最需要学会的一件事。",
      },
      {
        name: "最后一页",
        kicker: "其三 · 03 / 03",
        paragraphs: [
          "最后，我没有问你什么时候回来。这个问题太像一个期限，仿佛一切等待都必须以见面作为回报。",
          "我想，好的关系允许人暂时走远，也允许他在回头时看见一盏还亮着的灯。",
          "信纸翻到背面，我写了一句很普通的话：如果遇见喜欢的书，记得留一个名字给我。",
          "这一回，我终于把信装进了信封。"
        ],
        marked: "好的关系允许人暂时走远",
        companionThought: "愿意等，但不要求被等的人交出自由。",
      }
    ]
  },
  {
    id: "sea",
    title: "沿海慢行",
    subtitle: "一次没有目的地的旅行",
    author: "共读书房 · 原创演示",
    kind: "旅行",
    edition: "DEMO EDITION · 03",
    color: "blue",
    initials: "海",
    chapters: [
      {
        name: "凌晨的车站",
        kicker: "旅记 · 01 / 03",
        paragraphs: [
          "火车到站时，天还没有亮。站台边的自动贩卖机发出很轻的嗡鸣，远处海风带着湿润的咸味。",
          "我没有做详细的计划，只在笔记本第一页写下三个字：去看看。",
          "那些没有被日程表占满的时刻，总让我重新意识到世界并不是为了效率才存在的。",
          "第一班公交车沿着海岸开去，窗玻璃上逐渐浮现出浅灰色的清晨。"
        ],
        marked: "世界并不是为了效率才存在的。",
        companionThought: "真想某天背个包，什么也不赶。",
      },
      {
        name: "海边小镇",
        kicker: "旅记 · 02 / 03",
        paragraphs: [
          "小镇只有一条长街。面包铺、杂货店和邮局都把门开向同一个方向，像是在等待海风把谁带回来。",
          "下午涨潮，岸边的石阶没进水里。我坐在路旁看一位老人修补渔网，针线在她手中来回穿过，动作熟练得不需要看。",
          "有些生活不必被证明有多么精彩。它只是日复一日地发生，便有了自己的重量。",
          "太阳快落下时，我沿着街道走回旅馆。门口的猫已经换了个地方睡觉。"
        ],
        marked: "它只是日复一日地发生，便有了自己的重量。",
        companionThought: "原来平凡不是乏味，是另一种完整。",
      },
      {
        name: "潮汐表",
        kicker: "旅记 · 03 / 03",
        paragraphs: [
          "离开前，我在码头买了一张潮汐表。卖票的人告诉我，海水有自己的时间，不能按照旅客的安排涨落。",
          "我突然觉得，这像极了人和人之间的相处。你可以邀请、靠近、陪伴，却不能命令另一颗心按时抵达。",
          "返程的车窗外，海岸一点点退远。我把潮汐表夹进书里，想着以后再来。",
          "这趟旅行没有完成什么重要的事。但我带走了几段风声，和一整个缓慢的下午。"
        ],
        marked: "海水有自己的时间",
        companionThought: "旅行不是完成路线，也许是重新获得感受的能力。",
      }
    ]
  }
];

const initialNotes: DemoNote[] = seedBooks.flatMap(book =>
  book.chapters.map((chapter, chapterIndex) => ({
    id: book.id + "-" + chapterIndex,
    bookId: book.id,
    chapterIndex,
    quote: chapter.marked,
    content: chapter.companionThought,
    author: "共读伙伴" as const,
  }))
);

const kinds = ["全部", "小说", "随笔", "旅行", "我的导入"] as const;

export function DemoLibrary() {
  const [screen,setScreen] = useState<"library"|"reader"|"notes"|"bookmarks"|"settings">("library");
  const [books,setBooks] = useState<DemoBook[]>(seedBooks);
  const [progress,setProgress] = useState<Record<string,number>>({});
  const [pageProgress,setPageProgress] = useState<Record<string,number>>({});
  const [readingAnchors,setReadingAnchors] = useState<Record<string,number>>({});
  const [strokes,setStrokes] = useState<Stroke[]>([]);
  const [markings,setMarkings] = useState<Marking[]>([]);
  const [drawing,setDrawing] = useState(false);
  const [drawingTool,setDrawingTool] = useState<"pen"|"eraser">("pen");
  const [activeStroke,setActiveStroke] = useState<Stroke|null>(null);
  const [resolvedInk,setResolvedInk] = useState<Record<string,{page:number;points:{x:number;y:number}[]}>>({});
  const resolvedInkSignatureRef=useRef("");
  const [undoHistory,setUndoHistory] = useState<StrokeChange[]>([]);
  const [redoHistory,setRedoHistory] = useState<StrokeChange[]>([]);
  const [selection,setSelection] = useState<Selection|null>(null);
  const [replyDrafts,setReplyDrafts] = useState<Record<string,string>>({});
  const [importing,setImporting] = useState(false);
  const [localReady,setLocalReady] = useState(false);
  const [bookId,setBookId] = useState("rain");
  const [chapterIndex,setChapterIndex] = useState(0);
  const [pageOffset,setPageOffset] = useState(0);
  const [pageCount,setPageCount] = useState(1);
  const [paginationReady,setPaginationReady] = useState(false);
  const [progressPreview,setProgressPreview] = useState<number|null>(null);
  const [flowLayout,setFlowLayout] = useState({contentWidth:0,pageStep:0,pageInset:0});
  const [viewportWidth,setViewportWidth] = useState(0);
  const flowViewportRef=useRef<HTMLDivElement|null>(null);
  const flowRef=useRef<HTMLDivElement|null>(null);
  const pagesRef=useRef<HTMLDivElement|null>(null);
  // Keyboard events can arrive in the small interval between a React commit
  // and the effect that rebinds the listener. Keep navigation's source of
  // truth synchronous so a rapid Left/Right pair never uses a stale closure.
  const pageOffsetRef=useRef(0);
  const pageCountRef=useRef(1);
  const visiblePagesRef=useRef<1|2>(1);
  const layoutFrameRef=useRef<{key:string;signature:string}|null>(null);
  const pendingReflowAnchorRef=useRef<{key:string;ratio:number}|null>(null);
  const pendingBookAnchorRef=useRef<{chapterIndex:number;ratio:number}|null>(null);
  const progressPreviewRef=useRef<number|null>(null);
  const progressPointerActiveRef=useRef(false);
  const jumpToChapterEnd=useRef(false);
  const [kind,setKind] = useState<string>("全部");
  const [search,setSearch] = useState("");
  const [notes,setNotes] = useState<DemoNote[]>(initialNotes);
  const [noteDraft,setNoteDraft] = useState("");
  const [openNoteId,setOpenNoteId] = useState<string|null>(null);
  const [notesVisible,setNotesVisible] = useState(false);
  const [tocVisible,setTocVisible] = useState(false);
  const [night,setNight] = useState(false);
  const [fontSize,setFontSize] = useState(19);
  const [doublePage,setDoublePage] = useState(true);
  const [saved,setSaved] = useState<string[]>([]);
  const [notice,setNotice] = useState("");
  const noteSequence=useRef(0);
  const fileRef=useRef<HTMLInputElement|null>(null);
  const drawingRef=useRef<Stroke|null>(null);
  const erasedStrokesRef=useRef<Stroke[]>([]);
  useEffect(()=>{
    const task=window.setTimeout(()=>{
      try{
        const stored=localStorage.getItem(DEMO_STORAGE_KEY);
        if(stored&&stored.length<MAX_DEMO_STATE){
          const parsed=JSON.parse(stored) as Record<string,unknown>;
          if(parsed.version===1){
            if(Array.isArray(parsed.importedBooks)){
              const imported=(parsed.importedBooks as DemoBook[])
                .filter(b=>b&&b.imported===true&&typeof b.id==="string"&&
                  typeof b.title==="string"&&b.title.length<=80&&
                  Array.isArray(b.chapters)&&b.chapters.length>0&&b.chapters.length<=80&&
                  b.chapters.every(c=>typeof c.name==="string"&&Array.isArray(c.paragraphs)&&
                    c.paragraphs.every(p=>typeof p==="string"&&p.length<=3100)));
              setBooks([...seedBooks,...imported.slice(0,MAX_IMPORTED_BOOKS)]);
            }
            if(Array.isArray(parsed.notes)){
              const storedNotes=(parsed.notes as DemoNote[]).filter(n=>n&&
                (n.author==="我"||n.author==="共读伙伴")&&
                typeof n.id==="string"&&n.id.length<100&&typeof n.bookId==="string"&&
                typeof n.quote==="string"&&n.quote.length<=160&&
                typeof n.content==="string"&&n.content.length<=240&&
                Number.isInteger(n.chapterIndex)&&n.chapterIndex>=0)
                .slice(0,500).map(n=>({...n,
                  replies:Array.isArray(n.replies)?n.replies.filter(r=>r&&
                    typeof r.id==="string"&&typeof r.content==="string"&&
                    r.content.length<=240).slice(0,100):[],
                }));
              const overrides=new Map(storedNotes.map(n=>[n.id,n]));
              setNotes([...initialNotes.map(n=>overrides.get(n.id)??n),
                ...storedNotes.filter(n=>n.author==="我")]);
            }
            if(parsed.pageProgress&&typeof parsed.pageProgress==="object"&&!Array.isArray(parsed.pageProgress)){
              const p=parsed.pageProgress as Record<string,unknown>;
              setPageProgress(Object.fromEntries(Object.entries(p).filter(
                ([key,val])=>key.length<100&&Number.isInteger(val)&&Number(val)>=0&&Number(val)<10000
              )) as Record<string,number>);
            }
            if(parsed.readingAnchors&&typeof parsed.readingAnchors==="object"&&!Array.isArray(parsed.readingAnchors)){
              const anchors=parsed.readingAnchors as Record<string,unknown>;
              setReadingAnchors(Object.fromEntries(Object.entries(anchors).filter(
                ([key,val])=>key.length<=80&&typeof val==="number"&&Number.isFinite(val)&&val>=0&&val<=1
              )) as Record<string,number>);
            }
            if(Array.isArray(parsed.saved))setSaved(parsed.saved.filter(
              (x:unknown)=>typeof x==="string"&&x.length<=100).slice(0,300));
            if(parsed.progress&&typeof parsed.progress==="object"&&!Array.isArray(parsed.progress)){
              const p=parsed.progress as Record<string,unknown>;
              setProgress(Object.fromEntries(Object.entries(p).filter(
                ([key,val])=>key.length<=80&&Number.isInteger(val)&&Number(val)>=0&&Number(val)<=80
              )) as Record<string,number>);
            }
            if(Array.isArray(parsed.markings))setMarkings((parsed.markings as Marking[])
              .filter(x=>x&&typeof x.bookId==="string"&&typeof x.id==="string"&&
                typeof x.quote==="string"&&x.quote.length<=160&&x.quote.length>0&&
                Number.isInteger(x.chapterIndex)&&x.chapterIndex>=0&&
                (x.ranges===undefined||(Array.isArray(x.ranges)&&x.ranges.length<=40&&x.ranges.every(r=>
                  r&&Number.isInteger(r.paragraphIndex)&&r.paragraphIndex>=0&&
                  Number.isInteger(r.start)&&r.start>=0&&Number.isInteger(r.end)&&r.end>r.start))))
              .slice(0,500));
            if(Array.isArray(parsed.strokes))setStrokes((parsed.strokes as Stroke[]).filter(
              x=>x&&typeof x.id==="string"&&typeof x.bookId==="string"&&
                Number.isInteger(x.chapterIndex)&&Array.isArray(x.points)&&x.points.length<=1200&&
                (x.page===undefined||(Number.isInteger(x.page)&&x.page>=0&&x.page<10000))&&
                x.points.every(p=>typeof p.x==="number"&&p.x>=0&&p.x<=1&&
                  typeof p.y==="number"&&p.y>=0&&p.y<=1)
            ).slice(0,500));
            if(parsed.settings&&typeof parsed.settings==="object"){
              const prefs=parsed.settings as Record<string,unknown>;
              if(typeof prefs.night==="boolean")setNight(prefs.night);
              if(Number.isInteger(prefs.fontSize)&&Number(prefs.fontSize)>=16&&Number(prefs.fontSize)<=24)
                setFontSize(Number(prefs.fontSize));
              if(typeof prefs.doublePage==="boolean")setDoublePage(prefs.doublePage);
            }
            if(typeof parsed.recentBook==="string")setBookId(parsed.recentBook);
          }
        }
      }catch{/* Invalid local demo storage resets to bundled public-domain-style samples. */}
      setLocalReady(true);
    },0);
    return()=>window.clearTimeout(task);
  },[]);
  useEffect(()=>{
    if(!localReady)return;
    const timeout=window.setTimeout(()=>{
      try{
        const snapshot={
          version:1,
          importedBooks:books.filter(b=>b.imported),
          notes:notes.filter(n=>n.author==="我"||(n.replies?.length??0)>0),
          saved,progress,pageProgress,readingAnchors,strokes:strokes.filter(Boolean),markings,settings:{night,fontSize,doublePage},
          recentBook:bookId,
        };
        const serialized=JSON.stringify(snapshot);
        if(serialized.length>MAX_DEMO_STATE)
          throw Error("本地存储空间不足；请减少导入数量或备份后重置。");
        localStorage.setItem(DEMO_STORAGE_KEY,serialized);
      }catch{setNotice("本地保存失败：可能已达到浏览器容量限制。请先导出备份。");}
    },320);
    return()=>window.clearTimeout(timeout);
  },[localReady,books,notes,saved,progress,pageProgress,readingAnchors,strokes,markings,night,fontSize,doublePage,bookId]);

  const book=books.find(item=>item.id===bookId)??books[0];
  const safeChapterIndex=Math.max(0,Math.min(chapterIndex,book.chapters.length-1));
  const chapter=book.chapters[safeChapterIndex];
  const saveKey=book.id+":"+safeChapterIndex+":"+pageOffset;
  const bookmarked=saved.includes(saveKey);
  const currentNotes=notes.filter(item=>item.bookId===book.id && item.chapterIndex===safeChapterIndex);
  const tocEntries=book.toc??(book.imported?[]:book.chapters.map((item,index)=>({title:item.name,chapterIndex:index})));
  const allBookNotes=notes.filter(item=>item.bookId===book.id);
  const results=books.filter(item=>
    (kind==="全部"||(kind==="我的导入"?item.imported===true:item.kind===kind)) &&
    (item.title+item.subtitle+item.author).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );
  const chapterSourceLengths=book.chapters.map(chapterSourceLength);
  const wholeBookSourceLength=chapterSourceLengths.reduce((total,length)=>total+length,0);
  const sourceBeforeChapter=chapterSourceLengths.slice(0,safeChapterIndex)
    .reduce((total,length)=>total+length,0);
  // Page numbers are presentation-dependent. Store and move the reader in
  // original source space, then translate that anchor back into the currently
  // measured page columns whenever the reader has to reflow.
  const chapterSourceRatio=pageCount>1
    ?Math.min(1,Math.max(0,pageOffset/Math.max(1,pageCount-1)))
    :0;
  const derivedWholeBookRatio=Math.min(1,Math.max(0,
    (sourceBeforeChapter+chapterSourceLengths[safeChapterIndex]*chapterSourceRatio)/
    Math.max(1,wholeBookSourceLength),
  ));
  const wholeBookRatio=readingAnchors[book.id]??derivedWholeBookRatio;
  const activeProgressRatio=progressPreview??wholeBookRatio;
  const activeProgressPercent=Math.round(activeProgressRatio*100);
  // The desktop reader and its annotation sidebar share the same breakpoint.
  // Keeping the state breakpoint in lock-step with CSS is important: rendering
  // two logical pages while CSS hides one was previously another way to lose a
  // page from the reader's visible sequence.
  const visiblePages=doublePage&&viewportWidth>=1000?2:1;
  pageOffsetRef.current=pageOffset;
  pageCountRef.current=pageCount;
  visiblePagesRef.current=visiblePages;
  const pageKey=book.id+":"+safeChapterIndex;

  function locateWholeBookRatio(ratio:number){
    const normalized=Math.min(1,Math.max(0,ratio));
    const targetOffset=normalized*wholeBookSourceLength;
    let sourceStart=0;
    for(let index=0;index<chapterSourceLengths.length;index++){
      const sourceEnd=sourceStart+chapterSourceLengths[index];
      if(targetOffset<sourceEnd||index===chapterSourceLengths.length-1){
        return {
          chapterIndex:index,
          ratio:Math.min(1,Math.max(0,(targetOffset-sourceStart)/chapterSourceLengths[index])),
          sourceOffset:targetOffset,
        };
      }
      sourceStart=sourceEnd;
    }
    return {chapterIndex:0,ratio:0,sourceOffset:0};
  }
  function sourceRatioForPage(index:number,offset:number,total:number){
    const sourceBefore=chapterSourceLengths.slice(0,index).reduce((sum,length)=>sum+length,0);
    const withinChapter=total>1
      ?Math.min(1,Math.max(0,offset/Math.max(1,total-1)))
      :0;
    return Math.min(1,Math.max(0,
      (sourceBefore+chapterSourceLengths[index]*withinChapter)/Math.max(1,wholeBookSourceLength),
    ));
  }
  const progressLocation=locateWholeBookRatio(activeProgressRatio);
  // The active chapter's measured density provides an intentionally labelled
  // estimate while dragging across chapters that have not been paginated yet.
  const estimatedPage=Math.max(1,Math.round(
    progressLocation.sourceOffset/Math.max(1,chapterSourceLengths[safeChapterIndex]/Math.max(1,pageCount)),
  )+1);
  const previewPage=progressLocation.chapterIndex===safeChapterIndex
    ?Math.min(pageCount,Math.floor(progressLocation.ratio*Math.max(1,pageCount-1))+1)
    :estimatedPage;
  const progressAriaText=`全书已读 ${activeProgressPercent}%；预计第 ${previewPage} 页，第 ${progressLocation.chapterIndex+1} 段`;
  const progressSliderStyle={
    "--demo-progress-value":`${Math.round(activeProgressRatio*1000)/10}%`,
  } as CSSProperties;

  // A page number belongs to one measured column width. Keep a chapter-local
  // source position before a reflow, then translate it to the new page count.
  function preserveReflowAnchor(){
    const total=pageCountRef.current;
    if(total<2)return;
    pendingReflowAnchorRef.current={
      key:pageKey,
      ratio:Math.min(1,Math.max(0,pageOffsetRef.current/Math.max(1,total-1))),
    };
  }

  // CSS columns use the browser's own line wrapping. A physical page has a
  // fixed text viewport, so long PDF/EPUB/TXT chunks continue on later pages
  // rather than extending the document vertically or losing trailing lines.
  useLayoutEffect(()=>{
    if(screen!=="reader"||!pagesRef.current)return;
    const pages=pagesRef.current;
    const measure=()=>{
      const first=pages.querySelector<HTMLElement>(".demo-paper-page");
      if(!first)return;
      const firstRect=first.getBoundingClientRect();
      const second=pages.querySelector<HTMLElement>(".demo-paper-page-next");
      const secondRect=second?.getBoundingClientRect();
      const style=getComputedStyle(first);
      const pageInset=Math.max(0,
        parseFloat(style.paddingLeft)||0,
        parseFloat(style.paddingRight)||0,
      );
      const pageWidth=Math.max(1,firstRect.width);
      const pageStep=Math.max(1,secondRect
        ?secondRect.left-firstRect.left
        :pageWidth);
      const signature=[Math.round(pageWidth),Math.round(firstRect.height),second?2:1].join(":");
      const previous=layoutFrameRef.current;
      if(previous?.key===pageKey&&previous.signature!==signature&&pageCountRef.current>1){
        pendingReflowAnchorRef.current={
          key:pageKey,
          ratio:Math.min(1,Math.max(0,pageOffsetRef.current/Math.max(1,pageCountRef.current-1))),
        };
      }
      else if(previous?.key!==pageKey)pendingReflowAnchorRef.current=null;
      layoutFrameRef.current={key:pageKey,signature};
      setFlowLayout({
        contentWidth:Math.max(1,Math.round(pageWidth-pageInset*2)),
        pageStep:Math.round(pageStep),
        pageInset:Math.round(pageInset),
      });
      setViewportWidth(window.innerWidth);
    };
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(pages);
    window.addEventListener("resize",measure);
    return()=>{observer.disconnect();window.removeEventListener("resize",measure);};
  },[screen,book.id,safeChapterIndex,doublePage,pageKey]);
  useLayoutEffect(()=>{
    if(screen!=="reader"||!flowLayout.pageStep||!flowRef.current)return;
    setPaginationReady(false);
    let measureFrame:number|undefined;
    const frame=requestAnimationFrame(()=>{
      // The first frame applies the newly measured column width; the second
      // observes the resulting multi-column layout. Measuring in the first
      // frame can otherwise see a partial scroll extent and clamp a restored
      // page before the browser has created all of its columns.
      measureFrame=requestAnimationFrame(()=>{
      const flow=flowRef.current;
      if(!flow)return;
      const columnGap=Math.max(0,flowLayout.pageStep-flowLayout.contentWidth);
      // CSS transforms can shrink the reported scrollable extent in Chromium
      // once the current page has moved left. Measure the unshifted source so
      // opening the notes sidebar or restoring a saved page never turns a
      // later page into an apparent chapter end and clamps it backwards.
      const activeTransform=flow.style.transform;
      flow.style.transform="none";
      const fullFlowWidth=flow.scrollWidth;
      flow.style.transform=activeTransform;
      // A single source flow owns every physical column.  scrollWidth includes
      // the final content column but not its following gap, hence the one-gap
      // correction before converting its measured extent into page count.
      const total=Math.max(1,Math.ceil((fullFlowWidth+columnGap-2)/flowLayout.pageStep));
      pageCountRef.current=total;
      setPageCount(total);
      const lastStart=Math.floor((total-1)/visiblePages)*visiblePages;
      const bookAnchor=pendingBookAnchorRef.current;
      const reflowAnchor=pendingReflowAnchorRef.current;
      if(bookAnchor?.chapterIndex===safeChapterIndex){
        pendingBookAnchorRef.current=null;
        const target=Math.round(bookAnchor.ratio*Math.max(0,total-1));
        const normalized=Math.min(Math.floor(target/visiblePages)*visiblePages,lastStart);
        pageOffsetRef.current=normalized;
        setPageOffset(normalized);
        setPageProgress(old=>({...old,[pageKey]:normalized}));
      }else if(jumpToChapterEnd.current){
        jumpToChapterEnd.current=false;
        pageOffsetRef.current=lastStart;
        setPageOffset(lastStart);
        setReadingAnchors(old=>({...old,[book.id]:sourceRatioForPage(safeChapterIndex,lastStart,total)}));
      }else if(reflowAnchor?.key===pageKey){
        pendingReflowAnchorRef.current=null;
        const target=Math.round(reflowAnchor.ratio*Math.max(0,total-1));
        const normalized=Math.min(Math.floor(target/visiblePages)*visiblePages,lastStart);
        pageOffsetRef.current=normalized;
        setPageOffset(normalized);
        setPageProgress(old=>({...old,[pageKey]:normalized}));
      }else{
        setPageOffset(offset=>{
          const normalized=Math.min(
            Math.floor(Math.max(0,offset)/visiblePages)*visiblePages,
            lastStart,
          );
          pageOffsetRef.current=normalized;
          return normalized;
        });
      }
      setPaginationReady(true);
      });
    });
    return()=>{
      cancelAnimationFrame(frame);
      if(measureFrame!==undefined)cancelAnimationFrame(measureFrame);
    };
  },[screen,book.id,safeChapterIndex,flowLayout,fontSize,visiblePages,pageKey]);
  function previewWholeBookProgress(value:number){
    const ratio=Math.min(1,Math.max(0,value));
    progressPreviewRef.current=ratio;
    setProgressPreview(ratio);
  }
  function pointerProgressRatio(event:PointerEvent<HTMLInputElement>){
    const rect=event.currentTarget.getBoundingClientRect();
    return Math.min(1,Math.max(0,(event.clientX-rect.left)/Math.max(1,rect.width)));
  }
  function beginProgressPointer(event:PointerEvent<HTMLInputElement>){
    progressPointerActiveRef.current=true;
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{/* Synthetic touch tests have no native capture target. */}
    previewWholeBookProgress(pointerProgressRatio(event));
  }
  function moveProgressPointer(event:PointerEvent<HTMLInputElement>){
    if(progressPointerActiveRef.current)previewWholeBookProgress(pointerProgressRatio(event));
  }
  function endProgressPointer(event:PointerEvent<HTMLInputElement>){
    if(!progressPointerActiveRef.current)return;
    progressPointerActiveRef.current=false;
    try{
      if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    }catch{/* A cancelled or synthetic pointer can already be released. */}
    jumpToWholeBookProgress(pointerProgressRatio(event));
  }
  function jumpToWholeBookProgress(value:number){
    const ratio=Math.min(1,Math.max(0,value));
    progressPreviewRef.current=null;
    setProgressPreview(null);
    const target=locateWholeBookRatio(ratio);
    setReadingAnchors(old=>({...old,[book.id]:ratio}));
    if(target.chapterIndex===safeChapterIndex){
      const total=pageCountRef.current;
      const stride=visiblePagesRef.current;
      const lastStart=Math.floor((total-1)/stride)*stride;
      const raw=Math.round(target.ratio*Math.max(0,total-1));
      const next=Math.min(Math.floor(raw/stride)*stride,lastStart);
      pageOffsetRef.current=next;
      setPageOffset(next);
      setPageProgress(old=>({...old,[pageKey]:next}));
      setProgress(old=>({...old,[book.id]:safeChapterIndex}));
      return;
    }
    // The target chapter has its own physical column count.  Defer converting
    // the stable source anchor into a page offset until that chapter has been
    // measured, rather than reusing a page number from this chapter.
    pendingBookAnchorRef.current={chapterIndex:target.chapterIndex,ratio:target.ratio};
    pendingReflowAnchorRef.current=null;
    pageOffsetRef.current=0;pageCountRef.current=1;
    setPaginationReady(false);
    setChapterIndex(target.chapterIndex);setPageOffset(0);setPageCount(1);
    setProgress(old=>({...old,[book.id]:target.chapterIndex}));
  }
  function turnPage(delta:-1|1){
    if(!paginationReady)return;
    const stride=visiblePagesRef.current;
    const current=pageOffsetRef.current;
    const total=pageCountRef.current;
    if(delta===1){
      if(current+stride<total){
        const next=current+stride;
        pageOffsetRef.current=next;
        setPageOffset(next);
        setPageProgress(old=>({...old,[pageKey]:next}));
        setReadingAnchors(old=>({...old,[book.id]:sourceRatioForPage(safeChapterIndex,next,total)}));
      }else if(safeChapterIndex+1<book.chapters.length){
        goChapter(safeChapterIndex+1);
      }
    }else if(current>0){
      const next=Math.max(0,current-stride);
      pageOffsetRef.current=next;
      setPageOffset(next);
      setPageProgress(old=>({...old,[pageKey]:next}));
      setReadingAnchors(old=>({...old,[book.id]:sourceRatioForPage(safeChapterIndex,next,total)}));
    }else if(safeChapterIndex>0){
      jumpToChapterEnd.current=true;
      goChapter(safeChapterIndex-1);
    }
  }
  useEffect(()=>{
    if(screen!=="reader")return;
    const onKey=(event:globalThis.KeyboardEvent)=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      if(event.key==="Escape"){
        if(tocVisible||notesVisible||drawing||selection){
          endStroke();setTocVisible(false);setNotesVisible(false);setDrawing(false);setSelection(null);
          event.preventDefault();
        }
        return;
      }
      if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;
      const target=event.target;
      if(target instanceof HTMLElement&&
        (target.isContentEditable||["INPUT","TEXTAREA","SELECT"].includes(target.tagName)))return;
      event.preventDefault();
      turnPage(event.key==="ArrowRight"?1:-1);
    };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  });

  const allBookmarks=saved.flatMap(key=>{
    const [id,chapterPart,pagePart="0"]=key.split(":");
    const found=books.find(item=>item.id===id);
    const index=Number(chapterPart),physicalPage=Number(pagePart);
    return found&&Number.isInteger(index)&&index>=0&&index<found.chapters.length&&
      Number.isInteger(physicalPage)&&physicalPage>=0&&physicalPage<10000
      ? [{key,book:found,chapterIndex:index,physicalPage}]:[];
  });

  function navigate(next:"library"|"reader"|"notes"|"bookmarks"|"settings"){
    setScreen(next);setNotice("");
    if(next!=="reader"){setTocVisible(false);setNotesVisible(false);setDrawing(false);}
  }
  function openBook(id:string){
    const nextChapter=Math.min(progress[id]??0,(books.find(x=>x.id===id)?.chapters.length??1)-1);
    const nextPage=pageProgress[id+":"+nextChapter]??0;
    setBookId(id);setChapterIndex(nextChapter);
    pageOffsetRef.current=nextPage;
    setPaginationReady(false);
    setPageOffset(nextPage);setScreen("reader");
    setTocVisible(false);setOpenNoteId(null);setNoteDraft("");setNotesVisible(false);setNotice("");
  }
  function goChapter(index:number){
    if(index<0||index>=book.chapters.length)return;
    pageOffsetRef.current=0;pageCountRef.current=1;
    setPaginationReady(false);
    setChapterIndex(index);setPageOffset(0);setPageCount(1);
    setPageProgress(old=>({...old,[book.id+":"+index]:0}));
    setProgress(p=>({...p,[book.id]:index}));
    setReadingAnchors(old=>({...old,[book.id]:sourceRatioForPage(index,0,1)}));
    setOpenNoteId(null);setSelection(null);setDrawing(false);
    setTocVisible(false);setNotesVisible(false);setNoteDraft("");setNotice("");
  }
  function toggleBookmark(){
    setSaved(current=>current.includes(saveKey)?current.filter(k=>k!==saveKey):[...current,saveKey]);
    setNotice(bookmarked?"已移除这页的演示书签。":"已在当前页放入演示书签。");
  }
  async function importFile(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];
    event.currentTarget.value="";
    if(!file||importing)return;
    if(books.filter(b=>b.imported).length>=MAX_IMPORTED_BOOKS){
      setNotice("最多保存 5 本本地导入书籍；请先删除一本。");return;
    }
    const lower=file.name.toLowerCase();
    const isPdf=lower.endsWith(".pdf"),isEpub=lower.endsWith(".epub");
    if(!isPdf&&!isEpub&&!lower.endsWith(".txt")){
      setNotice("请选择 TXT、EPUB 或可提取文字的 PDF 文件。");return;
    }
    if(file.size>(isPdf?10000000:isEpub?8000000:2000000)){
      setNotice("文件过大：TXT 最多 2MB、EPUB 8MB、PDF 10MB。");return;
    }
    setImporting(true);setNotice("正在浏览器本地解析文件，不会上传。");
    try{
      const bytes=new Uint8Array(await file.arrayBuffer());
      const prepared=isPdf?await preparePdf(bytes):isEpub?await prepareEpub(bytes)
        :prepareTxt(decodeTxt(bytes,"utf-8"));
      const textLength=prepared.chunks.reduce((n,t)=>n+t.length,0);
      if(textLength>MAX_IMPORT_CHARS||prepared.chunks.length>80||prepared.chunks.length<1)
        throw Error("演示模式单本书最多 12 万字符、80 段；请选较短的测试读物。");
      const title=file.name.replace(/\.(?:txt|pdf|epub)$/i,"").slice(0,70);
      const id="local-"+crypto.randomUUID();
      const toc=prepared.chapters
        .filter((item,index,items)=>item.title.trim()&&item.chunkIndex>=0&&item.chunkIndex<prepared.chunks.length&&
          items.findIndex(other=>other.title===item.title&&other.chunkIndex===item.chunkIndex)===index)
        .map(item=>({title:item.title.slice(0,65),chapterIndex:item.chunkIndex}));
      const chapters:Chapter[]=prepared.chunks.map((body,index)=>{
        return {
          // A storage chunk is never a chapter title. Only a verified source
          // navigation entry may introduce one into the reading flow.
          name:toc.find(item=>item.chapterIndex===index)?.title??"",
          kicker:"本地导入 · "+String(index+1).padStart(2,"0")+" / "+prepared.chunks.length,
          paragraphs:body.split(/\n+/).map(p=>p.trim()).filter(Boolean),
          marked:"",companionThought:"",
        };
      });
      setBooks(old=>[...old,{id,title:title||"未命名作品",
        subtitle:"仅保存在当前浏览器 · 可以离线阅读",author:"我导入的测试读物",
        kind:"我的导入",edition:"LOCAL ONLY",color:"moss",initials:"本",
        chapters,
        toc,
        imported:true}]);
      setBookId(id);setChapterIndex(0);setPageOffset(0);setScreen("reader");setKind("全部");
      setNotice("已导入本地阅读。受浏览器容量限制，请及时备份，切勿依赖它保存唯一原稿。");
    }catch(error){
      setNotice(error instanceof Error?error.message:"无法安全解析此文件。");
    }finally{setImporting(false);}
  }
  function deleteLocalBook(id:string){
    if(!books.find(b=>b.id===id)?.imported)return;
    if(!window.confirm("将从这个浏览器的演示书架中删除此书及其批注、划线与书签。确定吗？"))return;
    setBooks(old=>old.filter(x=>x.id!==id));
    setNotes(old=>old.filter(n=>n.bookId!==id));
    setSaved(old=>old.filter(k=>!k.startsWith(id+":")));
    setMarkings(old=>old.filter(m=>m.bookId!==id));
    setStrokes(old=>old.filter(d=>d.bookId!==id));
    setProgress(old=>{const next={...old};delete next[id];return next;});
    if(bookId===id){setBookId("rain");setChapterIndex(0);setPageOffset(0);}
    setNotice("本地导入书籍已移除。");
  }
  function saveExport(){
    const raw=localStorage.getItem(DEMO_STORAGE_KEY);
    if(!raw){setNotice("还没有可导出的本地数据。");return;}
    const blob=new Blob([raw],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="reading-demo-backup.json";
    a.click();window.setTimeout(()=>URL.revokeObjectURL(url),3000);
    setNotice("已请求下载本地演示备份。它是明文 JSON，请妥善保存。");
  }
  function captureSelection(index:number,container:HTMLElement){
    if(drawing)return;
    const selected=window.getSelection();
    if(!selected||selected.isCollapsed||!selected.anchorNode||!selected.focusNode||
      !container.contains(selected.anchorNode)||!container.contains(selected.focusNode))return;
    const range=selected.getRangeAt(0);
    const quote=selected.toString().trim();
    if(quote.length<2||quote.length>160)return;
    const paragraphs=Array.from(container.querySelectorAll<HTMLElement>("p[data-paragraph-index]"));
    const paragraphFor=(node:Node)=>{
      const element=node.nodeType===Node.ELEMENT_NODE?node as Element:node.parentElement;
      return element?.closest<HTMLElement>("p[data-paragraph-index]")??null;
    };
    const startParagraph=paragraphFor(range.startContainer),endParagraph=paragraphFor(range.endContainer);
    const first=startParagraph?paragraphs.indexOf(startParagraph):-1;
    const last=endParagraph?paragraphs.indexOf(endParagraph):-1;
    if(first<0||last<first)return;
    const ranges=paragraphs.slice(first,last+1).flatMap((paragraph,relativeIndex)=>{
      const isFirst=relativeIndex===0,isLast=relativeIndex===last-first;
      const start=isFirst?textOffsetIn(paragraph,range.startContainer,range.startOffset):0;
      const end=isLast?textOffsetIn(paragraph,range.endContainer,range.endOffset):(paragraph.textContent?.length??0);
      const paragraphIndex=Number(paragraph.dataset.paragraphIndex);
      return Number.isInteger(paragraphIndex)&&start>=0&&end>start?[{paragraphIndex,start,end}]:[];
    });
    if(!ranges.length)return;
    setSelection({quote,chapterIndex:index,ranges});
  }
  function markSelection(){
    if(!selection||selection.chapterIndex!==chapterIndex)return;
    if(!markings.some(m=>m.bookId===book.id&&m.chapterIndex===chapterIndex&&
      JSON.stringify(m.ranges)===JSON.stringify(selection.ranges))){
      setMarkings(old=>[...old,{id:crypto.randomUUID(),bookId:book.id,
        chapterIndex,quote:selection.quote,ranges:selection.ranges}]);
    }
    setNotice("这段文字已划线，保存在当前浏览器。");
    window.getSelection()?.removeAllRanges();
  }
  function position(event:PointerEvent<SVGSVGElement>){
    const r=event.currentTarget.getBoundingClientRect();
    return {x:Math.min(1,Math.max(0,(event.clientX-r.left)/r.width)),
      y:Math.min(1,Math.max(0,(event.clientY-r.top)/r.height))};
  }
  function findStrokeAnchor(stroke:Stroke,layer:SVGSVGElement){
    const prose=document.querySelector<HTMLElement>(".demo-prose");
    const svgRect=layer.getBoundingClientRect();
    if(!prose||svgRect.width<1||svgRect.height<1||!stroke.points.length)return undefined;
    const strokeBounds={
      left:svgRect.left+Math.min(...stroke.points.map(point=>point.x))*svgRect.width,
      top:svgRect.top+Math.min(...stroke.points.map(point=>point.y))*svgRect.height,
      right:svgRect.left+Math.max(...stroke.points.map(point=>point.x))*svgRect.width,
      bottom:svgRect.top+Math.max(...stroke.points.map(point=>point.y))*svgRect.height,
    };
    let best:{paragraph:HTMLElement;start:number;end:number;rects:DOMRect[]}|undefined;
    for(const paragraph of Array.from(prose.querySelectorAll<HTMLElement>("p[data-paragraph-index]"))){
      const text=paragraph.textContent??"";
      let runStart=-1,runRects:DOMRect[]=[],candidate:{start:number;end:number;rects:DOMRect[]}|undefined;
      const commitRun=(end:number)=>{
        if(runStart<0)return;
        if(!candidate||end-runStart>candidate.end-candidate.start)
          candidate={start:runStart,end,rects:runRects};
        runStart=-1;runRects=[];
      };
      for(let index=0;index<text.length;index++){
        const range=textRangeAtOffsets(paragraph,index,index+1);
        const rect=Array.from(range?.getClientRects()??[]).find(item=>item.width>0&&item.height>0&&
          rectsOverlap(item,strokeBounds));
        if(rect){
          if(runStart<0)runStart=index;
          runRects.push(rect);
        }else commitRun(index);
      }
      commitRun(text.length);
      if(candidate&&(candidate.end-candidate.start)>=2&&
        (!best||candidate.end-candidate.start>best.end-best.start))
        best={paragraph,start:candidate.start,end:candidate.end,rects:candidate.rects};
    }
    if(!best)return undefined;
    const paragraphText=best.paragraph.textContent??"";
    let start=best.start,end=best.end;
    while(start<end&&/\s/.test(paragraphText[start]??""))start++;
    while(end>start&&/\s/.test(paragraphText[end-1]??""))end--;
    const quote=paragraphText.slice(start,end);
    if(quote.length<2||quote.length>240)return undefined;
    const range=textRangeAtOffsets(best.paragraph,start,end);
    const bounds=rectUnion(Array.from(range?.getClientRects()??[]).filter(rect=>rectsOverlap(rect,strokeBounds)));
    if(!bounds||bounds.right-bounds.left<2||bounds.bottom-bounds.top<2)return undefined;
    return {
      paragraphIndex:Number(best.paragraph.dataset.paragraphIndex),start,end,quote,
      sourceBounds:{
        x:(bounds.left-svgRect.left)/svgRect.width,
        y:(bounds.top-svgRect.top)/svgRect.height,
        width:(bounds.right-bounds.left)/svgRect.width,
        height:(bounds.bottom-bounds.top)/svgRect.height,
      },
    } satisfies StrokeAnchor;
  }
  const resolveStrokeForLayer=useCallback((stroke:Stroke,layer:SVGSVGElement)=>{
    const anchor=stroke.anchor;
    const prose=document.querySelector<HTMLElement>(".demo-prose");
    const flowViewport=flowViewportRef.current;
    const step=flowLayout.pageStep;
    const page=Number(layer.dataset.page);
    if(!anchor||!prose||!flowViewport||!Number.isInteger(page)||step<1)return undefined;
    const paragraph=prose.querySelector<HTMLElement>("p[data-paragraph-index=\""+anchor.paragraphIndex+"\"]");
    if(!paragraph||paragraph.textContent?.slice(anchor.start,anchor.end)!==anchor.quote)return undefined;
    const range=textRangeAtOffsets(paragraph,anchor.start,anchor.end);
    const viewportRect=flowViewport.getBoundingClientRect();
    const layerRect=layer.getBoundingClientRect();
    const rects=Array.from(range?.getClientRects()??[]).filter(rect=>rect.width>0&&rect.height>0);
    const pageRects=rects.filter(rect=>{
      const column=Math.floor((rect.left-viewportRect.left+pageOffset*step)/step);
      return column===page&&rectsOverlap(rect,layerRect);
    });
    const bounds=rectUnion(pageRects);
    if(!bounds)return undefined;
    const source=anchor.sourceBounds;
    const current={
      x:(bounds.left-layerRect.left)/layerRect.width,
      y:(bounds.top-layerRect.top)/layerRect.height,
      width:(bounds.right-bounds.left)/layerRect.width,
      height:(bounds.bottom-bounds.top)/layerRect.height,
    };
    if(source.width<0.0001||source.height<0.0001||current.width<0.0001||current.height<0.0001)return undefined;
    return {
      page,
      points:stroke.points.map(point=>({
        x:clampUnit(current.x+(point.x-source.x)/source.width*current.width),
        y:clampUnit(current.y+(point.y-source.y)/source.height*current.height),
      })),
    };
  },[flowLayout.pageStep,pageOffset]);
  useLayoutEffect(()=>{
    if(screen!=="reader"||!flowLayout.pageStep){
      if(resolvedInkSignatureRef.current!==""){
        resolvedInkSignatureRef.current="";setResolvedInk({});
      }
      return;
    }
    const next:Record<string,{page:number;points:{x:number;y:number}[]}>= {};
    const layers=Array.from(document.querySelectorAll<SVGSVGElement>(".demo-ink-layer"));
    for(const layer of layers){
      for(const stroke of strokes.filter(item=>item.bookId===book.id&&item.chapterIndex===safeChapterIndex&&item.anchor)){
        const resolved=resolveStrokeForLayer(stroke,layer);
        if(resolved)next[stroke.id]=resolved;
      }
    }
    const signature=JSON.stringify(next);
    if(signature!==resolvedInkSignatureRef.current){
      resolvedInkSignatureRef.current=signature;setResolvedInk(next);
    }
  },[screen,book.id,safeChapterIndex,pageOffset,pageCount,flowLayout,fontSize,visiblePages,strokes,resolveStrokeForLayer]);
  function recordStrokeChange(change:StrokeChange){
    if(!change.strokes.length)return;
    setUndoHistory(old=>[...old,change].slice(-80));
    setRedoHistory([]);
  }
  function eraseAt(point:{x:number;y:number},page:number){
    setStrokes(old=>{
      const erased=old.filter(stroke=>stroke.bookId===book.id&&stroke.chapterIndex===safeChapterIndex&&
        (resolvedInk[stroke.id]?.page??stroke.page??0)===page&&
        strokeDistance(resolvedInk[stroke.id]?.points??stroke.points,point)<.026&&
        !erasedStrokesRef.current.some(item=>item.id===stroke.id));
      if(!erased.length)return old;
      erasedStrokesRef.current=[...erasedStrokesRef.current,...erased];
      const ids=new Set(erased.map(item=>item.id));
      return old.filter(item=>!ids.has(item.id));
    });
  }
  function startStroke(event:PointerEvent<SVGSVGElement>,index:number,page:number){
    if(!drawing)return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if(drawingTool==="eraser"){
      erasedStrokesRef.current=[];
      eraseAt(position(event),page);
      return;
    }
    const stroke:Stroke={id:crypto.randomUUID(),bookId:book.id,chapterIndex:index,page,
      points:[position(event)]};
    drawingRef.current=stroke;setActiveStroke(stroke);
  }
  function moveStroke(event:PointerEvent<SVGSVGElement>){
    if(drawingTool==="eraser"){
      const page=Number(event.currentTarget.dataset.page??0);
      eraseAt(position(event),page);
      return;
    }
    if(!drawingRef.current)return;
    const stroke={...drawingRef.current,
      points:[...drawingRef.current.points.slice(-1198),position(event)]};
    drawingRef.current=stroke;setActiveStroke(stroke);
  }
  function endStroke(){
    // Capture the completed stroke before clearing the ref. React may run the
    // state updater later, after drawingRef.current has become null.
    const finished=drawingRef.current;
    drawingRef.current=null;
    setActiveStroke(null);
    if(finished&&finished.points.length>1){
      const layer=document.querySelector<SVGSVGElement>(".demo-ink-layer[data-page=\""+(finished.page??0)+"\"]");
      const anchored=layer?findStrokeAnchor(finished,layer):undefined;
      const persisted=anchored?{...finished,anchor:anchored}:finished;
      setStrokes(old=>[...old.filter(Boolean).slice(-499),persisted]);
      recordStrokeChange({kind:"add",strokes:[persisted]});
    }
    if(erasedStrokesRef.current.length){
      recordStrokeChange({kind:"remove",strokes:erasedStrokesRef.current});
      erasedStrokesRef.current=[];
    }
  }
  function undoStroke(){
    endStroke();
    setUndoHistory(old=>{
      const change=old.at(-1);if(!change)return old;
      setStrokes(strokes=>change.kind==="add"
        ?strokes.filter(stroke=>!change.strokes.some(item=>item.id===stroke.id))
        :[...strokes,...change.strokes.filter(item=>!strokes.some(stroke=>stroke.id===item.id))].slice(-500));
      setRedoHistory(redo=>[...redo,change].slice(-80));
      return old.slice(0,-1);
    });
  }
  function redoStroke(){
    setRedoHistory(old=>{
      const change=old.at(-1);if(!change)return old;
      setStrokes(strokes=>change.kind==="add"
        ?[...strokes,...change.strokes.filter(item=>!strokes.some(stroke=>stroke.id===item.id))].slice(-500)
        :strokes.filter(stroke=>!change.strokes.some(item=>item.id===stroke.id)));
      setUndoHistory(undo=>[...undo,change].slice(-80));
      return old.slice(0,-1);
    });
  }
  function clearCurrentPageInk(){
    endStroke();
    setStrokes(old=>{
      const removed=old.filter(stroke=>stroke.bookId===book.id&&stroke.chapterIndex===safeChapterIndex&&
        (resolvedInk[stroke.id]?.page??stroke.page??0)===pageOffset);
      if(!removed.length)return old;
      recordStrokeChange({kind:"remove",strokes:removed});
      const ids=new Set(removed.map(item=>item.id));
      return old.filter(stroke=>!ids.has(stroke.id));
    });
  }
  function sendReply(id:string){
    const content=replyDrafts[id]?.trim();
    if(!content||content.length>240)return;
    setNotes(old=>old.map(n=>n.id===id?{...n,replies:[...(n.replies??[]),{
      id:crypto.randomUUID(),content}]}:n));
    setReplyDrafts(old=>({...old,[id]:""}));
    setNotice("回复已存入本地演示数据。");
  }
  function saveNote(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const body=noteDraft.trim();
    if(body.length<2)return;
    const note:DemoNote={
      id:"me-"+(++noteSequence.current),
      bookId:book.id,
      chapterIndex,
      quote:selection?.chapterIndex===chapterIndex?selection.quote:(chapter.marked||chapter.paragraphs[0]?.slice(0,60)||""),
      content:body.slice(0,240),
      author:"我",
    };
    setNotes(current=>[...current,note]);
    setOpenNoteId(note.id);setNotesVisible(true);setNoteDraft("");setSelection(null);
    setNotice("批注已保存到本地浏览器；刷新页面后仍可查看。");
  }
  function removeNote(id:string){
    const item=notes.find(x=>x.id===id);
    if(item?.author!=="我")return;
    setNotes(current=>current.filter(x=>x.id!==id));
    if(openNoteId===id)setOpenNoteId(null);
    setNotice("已从演示界面移除这条批注。");
  }
  function renderPaper(shownPage:number,secondary=false,blank=false){
    return <article className={"demo-paper-page demo-physical-page"+
      (secondary?" demo-paper-page-next":"")+(blank?" demo-paper-page-blank":"")}
      key={book.id+":"+safeChapterIndex+":"+shownPage}
      aria-label={blank?"章节末尾留白页":chapter.name+" · 第 "+(shownPage+1)+" 页"}>
      <div className="demo-paper-footer">
        <span>SHARED READING ROOM</span>
        <span>{blank?"":String(shownPage+1).padStart(2,"0")+" / "+String(safeChapterIndex+1).padStart(2,"0")}</span>
      </div>
    </article>;
  }

  function renderInkLayer(shownPage:number,slot:0|1){
    const paperWidth=flowLayout.contentWidth>0
      ?flowLayout.contentWidth+flowLayout.pageInset*2
      :undefined;
    return <svg className={"demo-ink-layer"+(drawing?" demo-ink-active":"")}
      key={"ink:"+shownPage}
      // Stroke points are normalized to this SVG's local 0–1 viewBox. In a
      // single-page reader the paper itself is max-width constrained and
      // centered, so leave placement to the matching CSS frame instead of
      // reusing the two-page spread offset.
      style={visiblePages===2
        ?{left:slot===0?0:flowLayout.pageStep+"px",width:(paperWidth||undefined)}
        :undefined}
      viewBox="0 0 100 100" preserveAspectRatio="none"
      role="img" aria-label="本地演示手写标记层"
      data-page={shownPage}
      onPointerDown={e=>startStroke(e,safeChapterIndex,shownPage)}
      onPointerMove={moveStroke} onPointerUp={endStroke} onPointerCancel={endStroke}>
      {[...strokes.filter(t=>t&&t.bookId===book.id&&t.chapterIndex===safeChapterIndex&&
          (resolvedInk[t.id]?.page??t.page??0)===shownPage),
        ...(activeStroke?.bookId===book.id&&activeStroke.chapterIndex===safeChapterIndex&&
          (activeStroke.page??0)===shownPage?[activeStroke]:[])].map(t=>
        <polyline key={t.id} data-stroke-id={t.id} fill="none" stroke="#ac6550" strokeWidth=".65"
          strokeLinecap="round" strokeLinejoin="round"
          points={(resolvedInk[t.id]?.points??t.points).map(p=>(p.x*100)+","+(p.y*100)).join(" ")}/>
      )}
    </svg>;
  }

  function renderChapterFlow(){
    const linkedNote=notes.find(x=>x.bookId===book.id&&
      x.chapterIndex===safeChapterIndex&&x.author==="共读伙伴");
    const columnGap=Math.max(0,flowLayout.pageStep-flowLayout.contentWidth);
    const chapterMarkings=markings.filter(item=>item.bookId===book.id&&item.chapterIndex===safeChapterIndex);
    function openMarking(mark:Marking){
      const matched=notes.find(note=>note.bookId===book.id&&note.chapterIndex===safeChapterIndex&&note.quote===mark.quote);
      setOpenNoteId(matched?.id??linkedNote?.id??null);setTocVisible(false);setNotesVisible(true);
      setNotice("划线会始终显示；点击可查看或补充这段文字的批注。");
    }
    function markedParagraph(paragraph:string,paragraphIndex:number){
      const ranges=chapterMarkings.flatMap(mark=>{
        const anchored=(mark.ranges??[]).filter(range=>range.paragraphIndex===paragraphIndex)
          .map(range=>({...range,mark}));
        if(anchored.length)return anchored;
        // v1 data used only an excerpt. Preserve it without moving any old note.
        const start=mark.ranges? -1:paragraph.indexOf(mark.quote);
        return start<0?[]:[{paragraphIndex,start,end:start+mark.quote.length,mark}];
      });
      if(!ranges.length)return paragraph;
      const stops=[0,paragraph.length,...ranges.flatMap(range=>[range.start,range.end])]
        .filter(value=>value>=0&&value<=paragraph.length).sort((a,b)=>a-b)
        .filter((value,index,all)=>index===0||value!==all[index-1]);
      return stops.slice(0,-1).map((start,index)=>{
        const end=stops[index+1],content=paragraph.slice(start,end);
        const range=ranges.find(item=>item.start<=start&&item.end>=end);
        return range?<mark key={start+":"+end+":"+range.mark.id} className="demo-quoted-mark"
          role="button" tabIndex={0} aria-label={"查看这段划线与批注："+content}
          onClick={()=>openMarking(range.mark)} onKeyDown={event=>{
            if(event.key==="Enter"||event.key===" "){event.preventDefault();openMarking(range.mark);}
          }}>{content}</mark>:<span key={start+":"+end}>{content}</span>;
      });
    }
    return <div className="demo-flow-viewport" ref={flowViewportRef}>
      <div className="demo-column-flow" ref={flowRef}
        style={{
          width:flowLayout.contentWidth>0?flowLayout.contentWidth+"px":undefined,
          marginLeft:flowLayout.pageInset||undefined,
          columnWidth:flowLayout.contentWidth>0?flowLayout.contentWidth+"px":undefined,
          columnGap:columnGap||undefined,
          transform:flowLayout.pageStep>0
            ?"translate3d(-"+(pageOffset*flowLayout.pageStep)+"px,0,0)"
            :undefined,
        }}>
        {chapter.name&&<><div className="demo-chapter-ornament">✧</div>
          <div className="demo-chapter-kicker">{chapter.kicker}</div>
          <h2 className="demo-chapter-name">{chapter.name}</h2></>}
        <div className="demo-prose" style={{fontSize:fontSize+"px"}}
          onMouseUp={e=>captureSelection(safeChapterIndex,e.currentTarget)}
          onTouchEnd={e=>captureSelection(safeChapterIndex,e.currentTarget)}>
          {chapter.paragraphs.map((paragraph,i)=><p key={i} data-paragraph-index={i}>
            {markedParagraph(paragraph,i)}</p>)}
        </div>
      </div>
    </div>;
  }
  function renderNote(item:DemoNote){
    return <article key={item.id} className={"demo-note-card"+(openNoteId===item.id?" demo-note-selected":"")}>
      <div className="demo-note-author">
        <span className={"demo-mini-avatar"+(item.author==="我"?" demo-self-avatar":"")}>
          {item.author==="我"?"我":"伴"}
        </span>
        <strong>{item.author}</strong>
        <span>{item.author==="我"?"刚刚":"演示批注"}</span>
        {item.author==="我"&&<button type="button" className="demo-note-remove"
          onClick={()=>removeNote(item.id)} aria-label="删除我添加的这条演示批注">删除</button>}
      </div>
      <blockquote>“{item.quote}”</blockquote>
      <p>{item.content}</p>
      {(item.replies??[]).map(reply=><p key={reply.id} className="demo-local-reply">
        ↳ 我的回复：{reply.content}
      </p>)}
      <div className="demo-reply-row">
        <input aria-label={"回复 "+item.author+" 的批注"} maxLength={240}
          value={replyDrafts[item.id]??""} placeholder="写一条回复……"
          onChange={e=>setReplyDrafts(old=>({...old,[item.id]:e.target.value}))}/>
        <button type="button" disabled={!replyDrafts[item.id]?.trim()}
          onClick={()=>sendReply(item.id)}>回复</button>
      </div>
    </article>;
  }

  return (
    <div data-demo-ready={localReady?"yes":"no"} className={"demo-app"+(night?" demo-night":"")+(screen==="reader"?" demo-reading-mode":"")}>
      <aside className="demo-sidebar" aria-label="演示导航">
        <button className="demo-brand" onClick={()=>navigate("library")} type="button">
          <span className="demo-brand-seal">S<span>.</span></span>
          <span className="demo-brand-name"><strong>共读书房</strong><small>SHARED LIBRARY</small></span>
        </button>
        <div className="demo-sidebar-section-label">YOUR SPACE</div>
        <nav className="demo-menu" aria-label="主要页面">
          {([
            ["library","▦","我的书架"],
            ["reader","▤","正在阅读"],
            ["notes","✎","共读批注"],
            ["bookmarks","◇","我的书签"],
            ["settings","⚙","阅读设置"]
          ] as const).map(([id,glyph,label])=>
            <button type="button" key={id} aria-current={screen===id?"page":undefined}
              className={"demo-menu-item"+(screen===id?" demo-menu-active":"")}
              onClick={()=>navigate(id)}>
              <span aria-hidden="true" className="demo-menu-icon">{glyph}</span><span>{label}</span>
              {id==="notes"&&<span className="demo-menu-number">{allBookNotes.length}</span>}
            </button>
          )}
        </nav>
        <div className="demo-sidebar-spacer"/>
        <div className="demo-companion-mini">
          <div className="demo-companion-avatars"><span>我</span><span>伴</span></div>
          <div><strong>两个人的小书房</strong><small><span className="demo-online-dot"/>伙伴在线 · 模拟状态</small></div>
        </div>
        <p className="demo-sidebar-disclaimer">PREVIEW ONLY<br/>NO ACCOUNT · NO DATABASE</p>
      </aside>

      <div className="demo-workspace">
        <header className="demo-topbar">
          <div className="demo-topbar-crumb">
            <span>PRIVATE LIBRARY</span><span aria-hidden="true">/</span>
            <strong>{screen==="library"?"我的书架":screen==="reader"?book.title:screen==="notes"?"共读批注":screen==="bookmarks"?"我的书签":"阅读设置"}</strong>
          </div>
          <div className="demo-topbar-right">
            <span className="demo-local-chip"><span className="demo-local-dot"/>本地演示</span>
            <span className="demo-topbar-avatar" title="演示账号，无需登录">访</span>
          </div>
        </header>

        {screen==="library"&&(
          <main className="demo-content" aria-label="演示书架">
            <div className="demo-greeting"><span>A QUIET MOMENT TO READ</span><p>每一次翻页，都是一次相遇。</p></div>
            <section className="demo-hero">
              <div className="demo-hero-copy">
                <div className="demo-eyebrow"><span className="demo-gold-line"/> OUR LITTLE LIBRARY</div>
                <h1>让阅读，<br/><em>成为两个人的事。</em></h1>
                <p>不需要追赶同一个页码。你读你的故事，我在字里行间等你。</p>
                <button type="button" className="demo-hero-button" onClick={()=>openBook("rain")}>继续阅读 <span>↗</span></button>
              </div>
              <div className="demo-hero-art" aria-hidden="true">
                <div className="demo-art-halo"/>
                <div className="demo-art-book demo-art-back">S.<small>THE ART OF READING</small></div>
                <div className="demo-art-book demo-art-front"><span>雨<br/>停<br/>之<br/>前</span><i>01 —— 04</i></div>
                <div className="demo-art-cup"/>
                <div className="demo-art-shadow"/>
              </div>
            </section>

            <div className="demo-section-top">
              <div><span className="demo-section-overline">BOOK COLLECTION</span><h2>我们的书架 <sup>{books.length.toString().padStart(2,"0")}</sup></h2></div>
              <div className="demo-collection-tools">
                <input ref={fileRef} type="file" accept=".txt,.epub,.pdf" className="demo-file-input"
                  aria-label="从电脑本地导入 TXT EPUB 或 PDF 书籍"
                  onChange={e=>{void importFile(e);}}/>
                <button className="demo-import-button" type="button"
                  disabled={importing||books.filter(b=>b.imported).length>=MAX_IMPORTED_BOOKS}
                  onClick={()=>fileRef.current?.click()}>
                  {importing?"正在解析…":"＋ 导入本地书籍"}
                </button>
                <label className="demo-search"><span aria-hidden="true">⌕</span>
                  <input aria-label="搜索演示书籍" type="search" value={search}
                    onChange={e=>setSearch(e.target.value)} placeholder="搜索书名或作者"/>
                </label>
              </div>
            </div>
            <div className="demo-filter-row" aria-label="书籍分类">
              {kinds.map(k=><button type="button" key={k} aria-pressed={kind===k}
                className={"demo-filter"+(kind===k?" demo-filter-current":"")}
                onClick={()=>setKind(k)}>{k}</button>)}
            </div>
            <div className="demo-book-grid">
              {results.map(item=><div key={item.id} className="demo-book-entry">
                <button type="button" className="demo-book-card"
                onClick={()=>openBook(item.id)}>
                <div className={"demo-book-cover demo-cover-"+item.color}>
                  <div className="demo-cover-top">S. · EDITION</div>
                  <div className="demo-cover-flower">✳</div>
                  <div className="demo-cover-name">{item.title}</div>
                  <div className="demo-cover-bottom">{item.edition}</div>
                </div>
                <div className="demo-book-card-info">
                  <span className="demo-book-category">{item.kind} <span>·</span> {item.chapters.length} 个章节</span>
                  <h3>{item.title}</h3>
                  <p>{item.subtitle}</p>
                  <div className="demo-card-bottom"><span>查看并阅读</span><span className="demo-card-arrow">↗</span></div>
                </div>
                </button>
                {item.imported&&<button type="button" className="demo-delete-book"
                  onClick={()=>deleteLocalBook(item.id)}>删除本地书籍</button>}
              </div>)}
              {results.length===0&&<p className="demo-empty-search">没有符合条件的演示书籍。试试其他关键词。</p>}
            </div>
            <div className="demo-bottom-tip"><span>✦</span>
              演示书籍与伙伴在线状态为模拟内容。你导入的文字与操作仅在本地浏览器，不会连接数据库；公共设备上请删除本地数据。
            </div>
          </main>
        )}

        {screen==="reader"&&(
          <main className="demo-reader" aria-label="演示阅读器">
            <div className="demo-reader-toolbar">
              <div className="demo-reader-back">
                <button type="button" className="demo-back-button" onClick={()=>navigate("library")}>← 书架</button>
                <div><span>NOW READING</span><h1>{book.title}</h1></div>
              </div>
              <div className="demo-reader-actions">
                <button type="button" className={"demo-icon-action"+(bookmarked?" demo-icon-selected":"")}
                  aria-pressed={bookmarked} onClick={toggleBookmark}
                  title={bookmarked?"移除演示书签":"添加演示书签"}>{bookmarked?"◆":"◇"} <span>书签</span></button>
                {tocEntries.length>0&&<button type="button" className="demo-icon-action" aria-expanded={tocVisible}
                  onClick={()=>{setDrawing(false);setNotesVisible(false);setTocVisible(x=>!x);}}>☷ <span>目录</span></button>}
                <button type="button" className="demo-icon-action" aria-pressed={notesVisible}
                  onClick={()=>{setDrawing(false);setTocVisible(false);setNotesVisible(x=>!x);}}>✎ <span>批注</span></button>
                <button type="button" className={"demo-icon-action"+(drawing?" demo-icon-selected":"")}
                  aria-pressed={drawing} onClick={()=>{endStroke();setTocVisible(false);setNotesVisible(false);setDrawing(x=>!x);}}>
                  ✎ <span>{drawing?"结束手绘":"自由手绘"}</span></button>
                <button type="button" className="demo-icon-action" onClick={()=>navigate("settings")}>⚙ <span>设置</span></button>
              </div>
            </div>

            {tocVisible&&tocEntries.length>0&&<section className="demo-reader-panel demo-toc" role="dialog" aria-label="原书目录">
              <div className="demo-panel-heading"><div><strong>原书目录</strong><span>{tocEntries.length} ITEMS</span></div>
                <button type="button" className="demo-panel-close" onClick={()=>setTocVisible(false)} aria-label="关闭目录">×</button></div>
              <div className="demo-panel-scroll">{tocEntries.map((item,index)=><button key={item.chapterIndex+":"+item.title} type="button"
                className={item.chapterIndex===chapterIndex?"demo-toc-active":""} onClick={()=>goChapter(item.chapterIndex)}>
                <span>{String(index+1).padStart(2,"0")}</span> {item.title} {item.chapterIndex===chapterIndex?"· 正在读":""}
              </button>)}</div>
            </section>}

            {selection?.chapterIndex===chapterIndex&&!drawing&&<div className="demo-selection-toolbar"
              role="status"><span>已选「{selection.quote.slice(0,36)}{selection.quote.length>36?"…":""}」</span>
              <button type="button" onClick={markSelection}>划线保存</button>
              <button type="button" onClick={()=>{setTocVisible(false);setNotesVisible(true);
                document.getElementById("demo-new-note")?.focus();}}>写批注</button>
              <button type="button" onClick={()=>setSelection(null)}>取消</button></div>}
            {drawing&&<div className="demo-drawing-help">
              <span>手绘：笔迹按当前书页保存。</span>
              <button type="button" className={drawingTool==="pen"?"demo-tool-selected":""} onClick={()=>setDrawingTool("pen")}>画笔</button>
              <button type="button" className={drawingTool==="eraser"?"demo-tool-selected":""} onClick={()=>setDrawingTool("eraser")}>橡皮擦</button>
              <button type="button" disabled={!undoHistory.length} onClick={undoStroke}>撤销</button>
              <button type="button" disabled={!redoHistory.length} onClick={redoStroke}>重做</button>
              <button type="button" onClick={clearCurrentPageInk}>清除当前页笔迹</button>
              <button type="button" onClick={()=>setDrawing(false)}>完成</button>
            </div>}
            <div className="demo-reading-layout" data-paged="true">
              <div className="demo-book-column">
                <div ref={pagesRef} className={"demo-pages"+(visiblePages===2?" demo-pages-spread":"")}>
                  {renderPaper(pageOffset)}
                  {visiblePages===2&&renderPaper(pageOffset+1,true,pageOffset+1>=pageCount)}
                  {renderChapterFlow()}
                  {renderInkLayer(pageOffset,0)}
                  {visiblePages===2&&pageOffset+1<pageCount&&renderInkLayer(pageOffset+1,1)}
                </div>
                <div className="demo-page-navigation" data-page-count={pageCount} data-page-offset={pageOffset}
                  data-chapter={safeChapterIndex}>
                  <button type="button" disabled={!paginationReady||(safeChapterIndex===0&&pageOffset===0)}
                    aria-label="上一页" onClick={()=>turnPage(-1)}>‹ <span>上一页</span></button>
                  <div className="demo-reader-progress">
                    <div className="demo-progress-slider" style={progressSliderStyle} data-previewing={progressPreview!==null||undefined}>
                      {progressPreview!==null&&<output className="demo-progress-preview" aria-live="polite">
                        {activeProgressPercent}% · 预计第 {previewPage} 页
                      </output>}
                      <input type="range" min="0" max="100" step="0.1"
                        value={activeProgressRatio*100}
                        aria-label="全书阅读进度" aria-valuetext={progressAriaText}
                        aria-describedby="demo-progress-label"
                        onChange={event=>previewWholeBookProgress(Number(event.currentTarget.value)/100)}
                        onPointerDown={beginProgressPointer} onPointerMove={moveProgressPointer}
                        onPointerUp={endProgressPointer}
                        onPointerCancel={()=>{progressPointerActiveRef.current=false;progressPreviewRef.current=null;setProgressPreview(null);}}
                        onKeyUp={event=>{
                          if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(event.key))
                            jumpToWholeBookProgress(Number(event.currentTarget.value)/100);
                        }}
                        onBlur={event=>{
                          if(progressPreviewRef.current!==null)
                            jumpToWholeBookProgress(Number(event.currentTarget.value)/100);
                        }}/>
                    </div>
                    <div id="demo-progress-label" className="demo-progress-label">已读 {Math.round(wholeBookRatio*100)}% · 第 {Math.min(pageCount,pageOffset+1)}–{Math.min(pageCount,pageOffset+visiblePages)} / {pageCount} 页 · 第 {safeChapterIndex+1}/{book.chapters.length} 段</div>
                  </div>
                  <button type="button" disabled={!paginationReady||(safeChapterIndex===book.chapters.length-1&&pageOffset+visiblePages>=pageCount)}
                    aria-label="下一页" onClick={()=>turnPage(1)}><span>下一页</span> ›</button>
                </div>
              </div>
              {notesVisible&&<aside className="demo-reader-panel demo-annotation-aside" role="dialog" aria-label="当前章节共读批注">
                <div className="demo-panel-heading"><div className="demo-aside-heading"><span>IN THE MARGINS</span><h2>页边的对话 <sup>{currentNotes.length}</sup></h2></div>
                  <button type="button" className="demo-panel-close" onClick={()=>setNotesVisible(false)} aria-label="关闭批注">×</button></div>
                <p className="demo-aside-intro">彼此阅读互不打扰，在喜欢的句子旁留下想法。</p>
                <div className="demo-notes-feed">
                  {currentNotes.map(renderNote)}
                  {currentNotes.length===0&&<p className="demo-empty-notes">这一章还没有批注。</p>}
                </div>
                <form onSubmit={saveNote} className="demo-note-compose">
                  <label htmlFor="demo-new-note">写下此刻的想法</label>
                  <textarea id="demo-new-note" maxLength={240} value={noteDraft}
                    onChange={event=>setNoteDraft(event.target.value)}
                    placeholder="这段文字让我想到……"/>
                  <div><span>{noteDraft.length}/240</span>
                    <button type="submit" disabled={noteDraft.trim().length<2}>添加批注 ↗</button>
                  </div>
                </form>
                <p className="demo-aside-warning">纯本地演示：批注与书签可在此浏览器刷新后恢复，不会同步给伙伴。</p>
              </aside>}
            </div>
          </main>
        )}

        {screen==="notes"&&<main className="demo-content demo-narrow-content">
          <span className="demo-section-overline">THOUGHTS & HIGHLIGHTS</span>
          <h1 className="demo-page-title">那些想留下的句子。</h1>
          <p className="demo-page-description">一段文字，两种读法。批注和回复保存于本机，不会发送给别人。</p>
          <label className="demo-book-pick">选择演示书籍
            <select value={bookId} onChange={e=>{setBookId(e.target.value);setChapterIndex(0);setPageOffset(0);}}>
              {books.map(item=><option value={item.id} key={item.id}>{item.title}</option>)}
            </select>
          </label>
          <div className="demo-notes-list">
            {allBookNotes.map(item=><div className="demo-notes-list-item" key={item.id}>
              {renderNote(item)}
              <button type="button" onClick={()=>{
                setChapterIndex(item.chapterIndex);setPageOffset(0);setScreen("reader");
                setOpenNoteId(item.id);setNotesVisible(true);
              }}>前往第 {item.chapterIndex+1} 章 →</button>
            </div>)}
            {allBookNotes.length===0&&<p>还没有批注，先去读一章吧。</p>}
          </div>
        </main>}

        {screen==="bookmarks"&&<main className="demo-content demo-narrow-content">
          <span className="demo-section-overline">YOUR SAVED PLACES</span>
          <h1 className="demo-page-title">收藏过的阅读位置。</h1>
          <p className="demo-page-description">你收藏的页面都在这里，刷新后仍然保留在当前浏览器中。</p>
          <div className="demo-bookmark-list">
            {allBookmarks.map(entry=><div key={entry.key} className="demo-bookmark-item">
              <span>{entry.book.title} · {entry.book.chapters[entry.chapterIndex].name} · 第 {entry.physicalPage+1} 页</span>
              <button type="button" onClick={()=>{setBookId(entry.book.id);
                setChapterIndex(entry.chapterIndex);setPageOffset(entry.physicalPage);setScreen("reader");}}>前往阅读 →</button>
              <button type="button" onClick={()=>setSaved(old=>old.filter(k=>k!==entry.key))}>移除</button>
            </div>)}
            {allBookmarks.length===0&&<p>你还没有添加书签。打开一本书，点击右上角的书签按钮。</p>}
          </div>
        </main>}
        {screen==="settings"&&<main className="demo-content demo-narrow-content">
          <span className="demo-section-overline">MAKE IT YOURS</span>
          <h1 className="demo-page-title">给阅读一点自己的节奏。</h1>
          <p className="demo-page-description">这里调整的是演示界面的本地状态，不会改变真实账户或书房设置。</p>
          <section className="demo-settings-panel">
            <div className="demo-settings-row"><div><h2>阅读纸张</h2><p>你喜欢白天的温暖，还是夜里的安静？</p></div>
              <div className="demo-option-pair">
                <button type="button" className={!night?"demo-choice-current":""} aria-pressed={!night} onClick={()=>setNight(false)}>☀ 日间</button>
                <button type="button" className={night?"demo-choice-current":""} aria-pressed={night} onClick={()=>setNight(true)}>☾ 夜间</button>
              </div>
            </div>
            <div className="demo-settings-row"><div><h2>正文字号</h2><p>调节到读起来最舒服的大小。</p></div>
              <label className="demo-font-slider">
                <input type="range" min="16" max="24" step="1" value={fontSize}
                  onChange={event=>{preserveReflowAnchor();setFontSize(Number(event.target.value));}} aria-label="正文字号"/>
                <strong>{fontSize}px</strong>
              </label>
            </div>
            <div className="demo-settings-row"><div><h2>桌面双页</h2><p>宽屏像纸质书一样显示连续两页。点击左右翻页，不需要纵向滚动。</p></div>
              <button type="button" className={"demo-toggle"+(doublePage?" demo-toggle-on":"")}
                role="switch" aria-checked={doublePage} aria-label="桌面双页模式"
                onClick={()=>{preserveReflowAnchor();setDoublePage(x=>!x);}}><span/></button>
            </div>
            <div className="demo-settings-row"><div><h2>导出本地备份</h2>
              <p>把书签、导入文字、批注和设置保存为明文 JSON。请勿在公用设备存储敏感文字。</p></div>
              <button type="button" className="demo-reset-button" onClick={saveExport}>下载 JSON 备份</button>
            </div>
            <div className="demo-settings-row"><div><h2>恢复演示</h2><p>删除这个浏览器里所有演示数据（不可撤销）。</p></div>
              <button type="button" className="demo-reset-button" onClick={()=>{
                if(!window.confirm("确定删除本地导入书籍、划线、手绘、批注和书签？无法恢复。"))return;
                localStorage.removeItem(DEMO_STORAGE_KEY);
                setBooks(seedBooks);setBookId("rain");setChapterIndex(0);
                setNight(false);setFontSize(19);setDoublePage(true);setSaved([]);
                setProgress({});setPageProgress({});setPageOffset(0);setPageCount(1);
                setStrokes([]);setMarkings([]);setSelection(null);
                setNotes(initialNotes);setNoteDraft("");setOpenNoteId(null);
                setNotice("已清除本地数据并恢复初始演示。");
              }}>清除本地数据</button>
            </div>
          </section>
          <button type="button" className="demo-return-to-book" onClick={()=>navigate("reader")}>← 返回阅读界面</button>
        </main>}

        {notice&&<div className="demo-notice" role="status">
          <span>{notice}</span><button type="button" onClick={()=>setNotice("")} aria-label="关闭提示">×</button>
        </div>}
        <footer className="demo-global-footer"><span>© SHARED LIBRARY · DESIGN PREVIEW</span><span>免登录 · 仅本机保存 · 无云端同步</span></footer>
      </div>
    </div>
  );
}
