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
type MemberId="self"|"companion";
type NoteVisibility="public"|"private";
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
  /** Set only for locally imported books; older data may omit it. */
  addedAt?: number;
};
type DemoNote = {
  id: string;
  bookId: string;
  chapterIndex: number;
  quote: string;
  content: string;
  author: "我" | "共读伙伴";
  /** Stable local demo member identity; old notes infer this from `author`. */
  authorId?: MemberId;
  visibility?: NoteVisibility;
  ranges?: TextRange[];
  createdAt?: number;
  updatedAt?: number;
  replies?: {id:string;content:string}[];
};
type StrokeAnchor={paragraphIndex:number;start:number;end:number;quote:string;sourceBounds:{x:number;y:number;width:number;height:number}};
type Stroke={id:string;bookId:string;chapterIndex:number;page?:number;points:{x:number;y:number}[];anchor?:StrokeAnchor;
  authorId?:MemberId;color?:string;width?:number;visibility?:NoteVisibility;createdAt?:number;updatedAt?:number};
type TextRange={paragraphIndex:number;start:number;end:number};
type Selection={quote:string;chapterIndex:number;ranges:TextRange[]};
/** `quote` is retained for v1 local-storage compatibility. New markings use text ranges. */
type Marking={id:string;bookId:string;chapterIndex:number;quote:string;ranges?:TextRange[];noteId?:string;authorId?:MemberId};
type StrokeChange={kind:"add"|"remove";strokes:Stroke[]};
type FocusAnchor={bookId:string;chapterIndex:number;ranges:TextRange[];token:number};

const ANNOTATION_COLORS=[
  {name:"鼠尾草绿",value:"#729782"},
  {name:"陶土橘",value:"#BC8169"},
  {name:"雾霾蓝",value:"#7798B1"},
  {name:"灰紫色",value:"#A18AAE"},
  {name:"复古玫瑰",value:"#C48996"},
  {name:"琥珀金",value:"#C49E56"},
] as const;
const DRAWING_COLORS=[
  "#333333", "#D34E4E", "#E4834C", "#D9A52C", "#65A45B",
  "#198F86", "#3286C5", "#5669B5", "#9666B2", "#CE7F9C",
] as const;
const LEGACY_DRAWING_COLOR="#ac6550";
const DEFAULT_MEMBER_COLORS:Record<MemberId,string>={self:"#729782",companion:"#BC8169"};

function memberIdForNote(note:DemoNote):MemberId{
  return note.authorId??(note.author==="共读伙伴"?"companion":"self");
}
function noteIsVisible(note:DemoNote,reader:MemberId){
  return note.visibility!=="private"||memberIdForNote(note)===reader;
}
function normalizeMemberColors(value:unknown):Record<MemberId,string>{
  const source=value&&typeof value==="object"?value as Record<string,unknown>:{};
  const valid=(candidate:unknown):candidate is string=>ANNOTATION_COLORS.some(item=>item.value===candidate);
  const self=valid(source.self)?source.self:DEFAULT_MEMBER_COLORS.self;
  let companion=valid(source.companion)?source.companion:DEFAULT_MEMBER_COLORS.companion;
  if(companion===self)companion=ANNOTATION_COLORS.find(item=>item.value!==self)?.value??DEFAULT_MEMBER_COLORS.companion;
  return {self,companion};
}
function isDrawingColor(value:unknown):value is typeof DRAWING_COLORS[number]{
  return typeof value==="string"&&(DRAWING_COLORS as readonly string[]).includes(value);
}
function validTextRanges(value:unknown):value is TextRange[]{
  return Array.isArray(value)&&value.length<=40&&value.every(range=>range&&
    Number.isInteger(range.paragraphIndex)&&range.paragraphIndex>=0&&
    Number.isInteger(range.start)&&range.start>=0&&Number.isInteger(range.end)&&range.end>range.start);
}
function uniqueQuoteRanges(chapter:Chapter,quote:string):TextRange[]|null{
  const matches:TextRange[]=[];
  if(!quote.trim())return null;
  chapter.paragraphs.forEach((paragraph,paragraphIndex)=>{
    let from=0;
    while(from<=paragraph.length){
      const start=paragraph.indexOf(quote,from);
      if(start<0)break;
      matches.push({paragraphIndex,start,end:start+quote.length});
      from=start+Math.max(1,quote.length);
    }
  });
  return matches.length===1?matches:null;
}
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

type CoverMetadata={title:string;author:string;translator:string};
const SOURCE_METADATA_RE=/(?:z[\s-]*library|z[\s-]*lib|1lib|libgen|download|source|来源|下载|https?:\/\/|www\.|\.(?:com|net|org|sk|cc)\b)/i;

function isPlaceholderAuthor(value:string){
  return !value||/(?:unknown|n\/a|未(?:知|提供)|无名|作者不详|我导入的测试读物|测试读物)/i.test(value);
}

/**
 * Cover text is derived from the imported metadata at render time. The
 * original DemoBook record stays untouched so existing local data and
 * annotations remain compatible.
 */
function coverMetadata(book:Pick<DemoBook,"title"|"author">|null):CoverMetadata{
  if(!book)return {title:"书架空了",author:"",translator:""};
  let title=(book.title??"").normalize("NFKC")
    .replace(/\.(?:txt|epub|pdf|mobi|azw3)$/i,"")
    .replace(/\s+/g," ").trim();
  // Strip bracketed download/source fragments, URLs and bare source domains.
  title=title.replace(/\s*[（(【\[][^（）()【】\[\]]*?(?:z[\s-]*library|z[\s-]*lib|1lib|libgen|download|source|来源|下载|https?:\/\/|www\.|\.(?:com|net|org|sk|cc)\b)[^（）()【】\[\]]*[）)】\]]/giu,"");
  title=title.replace(/(?:https?:\/\/|www\.)\S+/giu,"")
    .replace(/\b(?:z[\s-]*library|z[\s-]*lib|1lib|libgen)\S*/giu,"")
    .replace(/\s{2,}/g," ").trim();

  let parsedAuthor="";
  let parsedTranslator="";
  // A trailing parenthetical is a reliable enough author cue for common
  // library exports such as “Title (Author, Translator)”. Never treat a
  // source-looking parenthetical as a person.
  const parenthetical=title.match(/^(.*?)\s*[（(]([^（）()]+)[）)]\s*$/u);
  if(parenthetical&&!SOURCE_METADATA_RE.test(parenthetical[2])){
    title=parenthetical[1].trim();
    const parts=parenthetical[2].split(/[，,；;|]/).map(item=>item.trim()).filter(Boolean);
    const labelledTranslator=parts.find(item=>/(?:译者|翻译|translator)/iu.test(item));
    const cleanLabel=(value:string)=>value.replace(/^(?:作者|author|译者|翻译|translator)\s*[:：]?\s*/iu,"").trim();
    if(parts[0]&&!/(?:译者|翻译|translator)/iu.test(parts[0]))parsedAuthor=cleanLabel(parts[0]);
    if(labelledTranslator)parsedTranslator=cleanLabel(labelledTranslator);
  }
  // Avoid displaying a placeholder injected by the local import demo.
  const authorCandidate=!isPlaceholderAuthor(parsedAuthor)?parsedAuthor:
    (!isPlaceholderAuthor(book.author??"")&&!SOURCE_METADATA_RE.test(book.author??"")?book.author.trim():"");
  const safeTitle=title.replace(/^[《「『【]|[》」』】]$/gu,"").trim()||"未命名作品";
  return {
    title:safeTitle,
    author:authorCandidate,
    translator:!isPlaceholderAuthor(parsedTranslator)?parsedTranslator:"",
  };
}

function coverTitleSize(title:string){
  const length=Array.from(title).length;
  if(length>=58)return 11;
  if(length>=44)return 12;
  if(length>=32)return 14;
  if(length>=23)return 16;
  if(length>=15)return 18;
  return 20;
}

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
  const [drawingColor,setDrawingColor] = useState<string>(DRAWING_COLORS[0]);
  const [activeStroke,setActiveStroke] = useState<Stroke|null>(null);
  const [resolvedInk,setResolvedInk] = useState<Record<string,{page:number;points:{x:number;y:number}[]}>>({});
  const resolvedInkSignatureRef=useRef("");
  const [undoHistory,setUndoHistory] = useState<StrokeChange[]>([]);
  const [redoHistory,setRedoHistory] = useState<StrokeChange[]>([]);
  const [selection,setSelection] = useState<Selection|null>(null);
  const [focusAnchor,setFocusAnchor] = useState<FocusAnchor|null>(null);
  const [focusedNoteIds,setFocusedNoteIds] = useState<string[]>([]);
  const [replyDrafts,setReplyDrafts] = useState<Record<string,string>>({});
  const [importing,setImporting] = useState(false);
  const [localReady,setLocalReady] = useState(false);
  const [bookId,setBookId] = useState("rain");
  const [hasRecentBook,setHasRecentBook] = useState(false);
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
  const [noteVisibility,setNoteVisibility] = useState<NoteVisibility>("public");
  const [activeReaderId,setActiveReaderId] = useState<MemberId>("self");
  const [memberColors,setMemberColors] = useState<Record<MemberId,string>>(DEFAULT_MEMBER_COLORS);
  const [tocVisible,setTocVisible] = useState(false);
  const [night,setNight] = useState(false);
  const [fontSize,setFontSize] = useState(19);
  const [doublePage,setDoublePage] = useState(true);
  const [saved,setSaved] = useState<string[]>([]);
  const [notice,setNotice] = useState("");
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
                Number.isInteger(n.chapterIndex)&&n.chapterIndex>=0&&
                (n.authorId===undefined||n.authorId==="self"||n.authorId==="companion")&&
                (n.visibility===undefined||n.visibility==="public"||n.visibility==="private")&&
                (n.ranges===undefined||validTextRanges(n.ranges)))
                .slice(0,500).map(n=>({...n,
                  authorId:memberIdForNote(n),
                  visibility:(n.visibility==="private"?"private":"public") as NoteVisibility,
                  ranges:validTextRanges(n.ranges)?n.ranges:undefined,
                  replies:Array.isArray(n.replies)?n.replies.filter(r=>r&&
                    typeof r.id==="string"&&typeof r.content==="string"&&
                    r.content.length<=240).slice(0,100):[],
                }));
              const overrides=new Map(storedNotes.map(n=>[n.id,n]));
              const initialIds=new Set(initialNotes.map(n=>n.id));
              setNotes([...initialNotes.map(n=>overrides.get(n.id)??n),
                ...storedNotes.filter(n=>!initialIds.has(n.id))]);
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
                (x.noteId===undefined||typeof x.noteId==="string")&&
                (x.authorId===undefined||x.authorId==="self"||x.authorId==="companion")&&
                (x.ranges===undefined||(Array.isArray(x.ranges)&&x.ranges.length<=40&&x.ranges.every(r=>
                  r&&Number.isInteger(r.paragraphIndex)&&r.paragraphIndex>=0&&
                  Number.isInteger(r.start)&&r.start>=0&&Number.isInteger(r.end)&&r.end>r.start))))
              .slice(0,500).map(mark=>({...mark,authorId:mark.authorId??"self"})));
            if(Array.isArray(parsed.strokes))setStrokes((parsed.strokes as Stroke[]).filter(
              x=>x&&typeof x.id==="string"&&typeof x.bookId==="string"&&
                Number.isInteger(x.chapterIndex)&&Array.isArray(x.points)&&x.points.length<=1200&&
                (x.page===undefined||(Number.isInteger(x.page)&&x.page>=0&&x.page<10000))&&
                (x.authorId===undefined||x.authorId==="self"||x.authorId==="companion")&&
                (x.color===undefined||typeof x.color==="string")&&
                (x.width===undefined||typeof x.width==="number"&&x.width>0&&x.width<10)&&
                x.points.every(p=>typeof p.x==="number"&&p.x>=0&&p.x<=1&&
                  typeof p.y==="number"&&p.y>=0&&p.y<=1)
            ).slice(0,500).map(stroke=>({...stroke,authorId:stroke.authorId??"self",
              visibility:stroke.visibility==="private"?"private":"public"})));
            if(parsed.settings&&typeof parsed.settings==="object"){
              const prefs=parsed.settings as Record<string,unknown>;
              if(typeof prefs.night==="boolean")setNight(prefs.night);
              if(Number.isInteger(prefs.fontSize)&&Number(prefs.fontSize)>=16&&Number(prefs.fontSize)<=24)
                setFontSize(Number(prefs.fontSize));
              // Desktop reading is now always a two-page spread. Keep the
              // legacy preference readable, but migrate an old single-page
              // value to true instead of reopening the reader in one page.
              if(typeof prefs.doublePage==="boolean")setDoublePage(true);
              if(prefs.memberColors)setMemberColors(normalizeMemberColors(prefs.memberColors));
              if(prefs.activeReaderId==="self"||prefs.activeReaderId==="companion")setActiveReaderId(prefs.activeReaderId);
              if(isDrawingColor(prefs.drawingColor))setDrawingColor(prefs.drawingColor);
            }
            if(typeof parsed.recentBook==="string"){
              setBookId(parsed.recentBook);setHasRecentBook(true);
            }
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
          notes,
          saved,progress,pageProgress,readingAnchors,strokes:strokes.filter(Boolean),markings,
          settings:{night,fontSize,doublePage,memberColors,activeReaderId,drawingColor},
          ...(hasRecentBook?{recentBook:bookId}:{}),
        };
        const serialized=JSON.stringify(snapshot);
        if(serialized.length>MAX_DEMO_STATE)
          throw Error("本地存储空间不足；请减少导入数量或备份后重置。");
        localStorage.setItem(DEMO_STORAGE_KEY,serialized);
      }catch{setNotice("本地保存失败：可能已达到浏览器容量限制。请先导出备份。");}
    },320);
    return()=>window.clearTimeout(timeout);
  },[localReady,books,notes,saved,progress,pageProgress,readingAnchors,strokes,markings,night,fontSize,doublePage,bookId,hasRecentBook,memberColors,activeReaderId,drawingColor]);

  const hasReadingState=(id:string)=>Object.prototype.hasOwnProperty.call(readingAnchors,id)||
    Object.prototype.hasOwnProperty.call(progress,id)||
    Object.keys(pageProgress).some(key=>key.startsWith(id+":"));
  const recentOpenedBook=hasRecentBook?books.find(item=>item.id===bookId)??null:null;
  const recentReadingBook=recentOpenedBook&&hasReadingState(recentOpenedBook.id)?recentOpenedBook:null;
  const recentAddedBook=books.filter(item=>item.imported&&Number.isFinite(item.addedAt))
    .sort((a,b)=>(b.addedAt??0)-(a.addedAt??0))[0]??null;
  const heroBook=recentReadingBook??recentOpenedBook??recentAddedBook??(books.length?books[0]:null);
  const heroCover=coverMetadata(heroBook);
  const heroCoverTitleSize=coverTitleSize(heroCover.title);
  const book=books.find(item=>item.id===bookId)??books[0]??seedBooks[0];
  const heroProgress=heroBook?Math.round(clampUnit(
    typeof readingAnchors[heroBook.id]==="number"
      ?readingAnchors[heroBook.id]
      :(heroBook.chapters.length>1?(progress[heroBook.id]??0)/(heroBook.chapters.length-1):0)
  )*100):0;
  const safeChapterIndex=Math.max(0,Math.min(chapterIndex,book.chapters.length-1));
  const chapter=book.chapters[safeChapterIndex];
  const saveKey=book.id+":"+safeChapterIndex+":"+pageOffset;
  const bookmarked=saved.includes(saveKey);
  const visibleNotes=notes.filter(item=>noteIsVisible(item,activeReaderId));
  const currentNotes=visibleNotes.filter(item=>item.bookId===book.id && item.chapterIndex===safeChapterIndex);
  const tocEntries=book.toc??(book.imported?[]:book.chapters.map((item,index)=>({title:item.name,chapterIndex:index})));
  const allBookNotes=visibleNotes.filter(item=>item.bookId===book.id);
  useEffect(()=>{
    if(!focusAnchor)return;
    const timeout=window.setTimeout(()=>setFocusAnchor(null),1800);
    return()=>window.clearTimeout(timeout);
  },[focusAnchor]);
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
  // The desktop reader is intentionally fixed to a continuous two-page
  // spread. Below the desktop breakpoint the existing single-page behavior
  // remains unchanged for phones and tablets.
  const visiblePages=viewportWidth>=1000?2:1;
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
  useEffect(()=>{
    if(screen!=="reader"||drawing)return;
    const onSelectionChange=()=>{
      const selected=window.getSelection();
      const node=selected?.anchorNode;
      const element=node?.nodeType===Node.ELEMENT_NODE?node as Element:node?.parentElement;
      const prose=element?.closest<HTMLElement>(".demo-prose");
      if(prose)captureSelection(safeChapterIndex,prose);
    };
    document.addEventListener("selectionchange",onSelectionChange);
    return()=>document.removeEventListener("selectionchange",onSelectionChange);
  },[screen,drawing,safeChapterIndex,book.id]);

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
    setBookId(id);setHasRecentBook(true);setChapterIndex(nextChapter);
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
        imported:true,addedAt:Date.now()}]);
      setBookId(id);setHasRecentBook(true);setChapterIndex(0);setPageOffset(0);setScreen("reader");setKind("全部");
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
    if(bookId===id){setBookId("rain");setHasRecentBook(false);setChapterIndex(0);setPageOffset(0);}
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
    if(drawing){container.dataset.selectionState="drawing";return;}
    const selected=window.getSelection();
    if(!selected||selected.isCollapsed||!selected.anchorNode||!selected.focusNode||
      !container.contains(selected.anchorNode)||!container.contains(selected.focusNode)){
      container.dataset.selectionState="outside";return;
    }
    const range=selected.getRangeAt(0);
    const quote=selected.toString().trim();
    if(quote.length<2||quote.length>160){container.dataset.selectionState="length";return;}
    const paragraphs=Array.from(container.querySelectorAll<HTMLElement>("p[data-paragraph-index]"));
    const paragraphFor=(node:Node)=>{
      const element=node.nodeType===Node.ELEMENT_NODE?node as Element:node.parentElement;
      return element?.closest<HTMLElement>("p[data-paragraph-index]")??null;
    };
    const startParagraph=paragraphFor(range.startContainer),endParagraph=paragraphFor(range.endContainer);
    const first=startParagraph?paragraphs.indexOf(startParagraph):-1;
    const last=endParagraph?paragraphs.indexOf(endParagraph):-1;
    let ranges:TextRange[]=first<0||last<first?[]:paragraphs.slice(first,last+1).flatMap((paragraph,relativeIndex)=>{
      const isFirst=relativeIndex===0,isLast=relativeIndex===last-first;
      const start=isFirst?textOffsetIn(paragraph,range.startContainer,range.startOffset):0;
      const end=isLast?textOffsetIn(paragraph,range.endContainer,range.endOffset):(paragraph.textContent?.length??0);
      const paragraphIndex=Number(paragraph.dataset.paragraphIndex);
      return Number.isInteger(paragraphIndex)&&start>=0&&end>start?[{paragraphIndex,start,end}]:[];
    });
    // Browser selection endpoints can be normalized to a column wrapper after
    // a reflow. Fall back to the selected source text, never to a pixel box.
    if(!ranges.length){
      const fallback=paragraphs.find(paragraph=>(paragraph.textContent??"").includes(quote));
      const start=fallback?.textContent?.indexOf(quote)??-1;
      const paragraphIndex=Number(fallback?.dataset.paragraphIndex);
      if(fallback&&start>=0&&Number.isInteger(paragraphIndex))ranges=[{paragraphIndex,start,end:start+quote.length}];
    }
    if(!ranges.length){container.dataset.selectionState="unanchored";return;}
    container.dataset.selectionState="saved";
    setSelection({quote,chapterIndex:index,ranges});
  }
  function markSelection(){
    if(!selection||selection.chapterIndex!==chapterIndex)return;
    if(!markings.some(m=>m.bookId===book.id&&m.chapterIndex===chapterIndex&&
      JSON.stringify(m.ranges)===JSON.stringify(selection.ranges))){
      setMarkings(old=>[...old,{id:crypto.randomUUID(),bookId:book.id,
        chapterIndex,quote:selection.quote,ranges:selection.ranges,authorId:activeReaderId}]);
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
    const viewportRect=flowViewportRef.current?.getBoundingClientRect();
    const step=flowLayout.pageStep;
    const expectedPage=Number(layer.dataset.page??stroke.page??0);
    const rectBelongsToDrawnPage=(rect:DOMRect)=>{
      if(!viewportRect||step<1||!Number.isInteger(expectedPage))return true;
      const center=(rect.left+rect.right)/2;
      const column=Math.floor((center-viewportRect.left+pageOffset*step)/step);
      return column===expectedPage;
    };
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
          rectsOverlap(item,strokeBounds)&&rectBelongsToDrawnPage(item));
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
      // A line can straddle the boundary between two physical sheets. Using
      // its left edge assigns that line to the previous page and can move a
      // right-page stroke onto the left sheet after a refresh. The glyph run's
      // center is stable for the page that contains most of the selected text.
      const center=(rect.left+rect.right)/2;
      const column=Math.floor((center-viewportRect.left+pageOffset*step)/step);
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
      points:[position(event)],authorId:activeReaderId,color:drawingColor,width:.65,
      visibility:"public",createdAt:Date.now(),updatedAt:Date.now()};
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
  function rangesForNote(note:DemoNote):TextRange[]|null{
    const targetBook=books.find(item=>item.id===note.bookId);
    const targetChapter=targetBook?.chapters[note.chapterIndex];
    if(!targetChapter)return null;
    if(validTextRanges(note.ranges)&&note.ranges.every(range=>{
      const paragraph=targetChapter.paragraphs[range.paragraphIndex];
      return !!paragraph&&range.end<=paragraph.length;
    }))return note.ranges;
    return uniqueQuoteRanges(targetChapter,note.quote);
  }
  function rangesForMark(mark:Marking):TextRange[]|null{
    if(validTextRanges(mark.ranges))return mark.ranges;
    const linked=mark.noteId?notes.find(note=>note.id===mark.noteId):undefined;
    if(linked){
      const linkedRanges=rangesForNote(linked);
      if(linkedRanges)return linkedRanges;
    }
    const targetBook=books.find(item=>item.id===mark.bookId);
    const targetChapter=targetBook?.chapters[mark.chapterIndex];
    return targetChapter?uniqueQuoteRanges(targetChapter,mark.quote):null;
  }
  function openMarkings(selected:Marking[]){
    const ids=new Set(selected.flatMap(mark=>mark.noteId?[mark.noteId]:[]));
    const quotes=new Set(selected.map(mark=>mark.quote));
    const related=visibleNotes.filter(note=>ids.has(note.id)||quotes.has(note.quote));
    setFocusedNoteIds(related.map(note=>note.id));
    setOpenNoteId(related[0]?.id??null);
    setTocVisible(false);setNotesVisible(true);
    setNotice(related.length>1?"这段文字有多条批注，已在右侧展开。":"已打开这段文字对应的批注。");
  }
  function openNoteQuote(note:DemoNote){
    const ranges=rangesForNote(note);
    if(!ranges){
      setOpenNoteId(note.id);setFocusedNoteIds([note.id]);setNotesVisible(true);
      setNotice("这条旧批注的原文位置待确认，已保留批注内容。");
      return;
    }
    const targetBook=books.find(item=>item.id===note.bookId);
    const targetChapter=targetBook?.chapters[note.chapterIndex];
    if(!targetBook||!targetChapter)return;
    const first=ranges[0];
    const before=targetChapter.paragraphs.slice(0,first.paragraphIndex)
      .reduce((total,paragraph)=>total+paragraph.length+2,0);
    const ratio=clampUnit((before+first.start)/chapterSourceLength(targetChapter));
    const sameMeasuredChapter=targetBook.id===book.id&&note.chapterIndex===safeChapterIndex&&
      pageCountRef.current>1&&paginationReady;
    if(sameMeasuredChapter){
      const raw=Math.round(ratio*Math.max(0,pageCountRef.current-1));
      const next=Math.min(Math.floor(raw/visiblePagesRef.current)*visiblePagesRef.current,
        Math.floor((pageCountRef.current-1)/visiblePagesRef.current)*visiblePagesRef.current);
      pendingBookAnchorRef.current=null;pendingReflowAnchorRef.current=null;
      pageOffsetRef.current=next;setPageOffset(next);
      setPageProgress(old=>({...old,[targetBook.id+":"+note.chapterIndex]:next}));
    }else{
      pendingBookAnchorRef.current={chapterIndex:note.chapterIndex,ratio};
      pendingReflowAnchorRef.current=null;
      pageOffsetRef.current=0;pageCountRef.current=1;
      setPaginationReady(false);setPageOffset(0);setPageCount(1);
    }
    setBookId(note.bookId);setHasRecentBook(true);setChapterIndex(note.chapterIndex);
    setProgress(old=>({...old,[note.bookId]:note.chapterIndex}));
    setPageProgress(old=>({...old,[note.bookId+":"+note.chapterIndex]:0}));
    setOpenNoteId(note.id);setFocusedNoteIds([note.id]);setTocVisible(false);setNotesVisible(true);
    setFocusAnchor({bookId:note.bookId,chapterIndex:note.chapterIndex,ranges,token:Date.now()});
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
    const noteId=(activeReaderId==="self"?"me-":"companion-")+crypto.randomUUID();
    const noteRanges=selection?.chapterIndex===chapterIndex?selection.ranges:undefined;
    const note:DemoNote={
      id:noteId,
      bookId:book.id,
      chapterIndex,
      quote:selection?.chapterIndex===chapterIndex?selection.quote:(chapter.marked||chapter.paragraphs[0]?.slice(0,60)||""),
      content:body.slice(0,240),
      author:activeReaderId==="self"?"我":"共读伙伴",
      authorId:activeReaderId,visibility:noteVisibility,ranges:noteRanges,
      createdAt:Date.now(),updatedAt:Date.now(),
    };
    setNotes(current=>[...current,note]);
    if(noteRanges){
      setMarkings(old=>{
        const reusable=old.find(mark=>mark.bookId===book.id&&mark.chapterIndex===chapterIndex&&
          !mark.noteId&&JSON.stringify(mark.ranges)===JSON.stringify(noteRanges));
        if(reusable)return old.map(mark=>mark.id===reusable.id?{...mark,noteId:note.id,authorId:activeReaderId}:mark);
        return [...old,{id:crypto.randomUUID(),bookId:book.id,chapterIndex,quote:note.quote,
          ranges:noteRanges,noteId:note.id,authorId:activeReaderId}];
      });
    }
    setOpenNoteId(note.id);setFocusedNoteIds([note.id]);setNotesVisible(true);setNoteDraft("");setSelection(null);
    setNotice("批注已保存到本地浏览器；刷新页面后仍可查看。");
  }
  function removeNote(id:string){
    const item=notes.find(x=>x.id===id);
    if(!item||memberIdForNote(item)!==activeReaderId)return;
    setNotes(current=>current.filter(x=>x.id!==id));
    setMarkings(current=>current.filter(mark=>mark.noteId!==id));
    if(openNoteId===id)setOpenNoteId(null);
    setNotice("已从演示界面移除这条批注。");
  }
  function toggleNoteVisibility(id:string){
    const item=notes.find(x=>x.id===id);
    if(!item||memberIdForNote(item)!==activeReaderId)return;
    const nextVisibility:NoteVisibility=item.visibility==="private"?"public":"private";
    setNotes(current=>current.map(note=>note.id===id?{...note,visibility:nextVisibility,updatedAt:Date.now()}:note));
    setNotice(nextVisibility==="private"?"这条批注已改为仅自己可见。":"这条批注已改为双方可见。");
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
        <polyline key={t.id} data-stroke-id={t.id} fill="none" stroke={t.color??LEGACY_DRAWING_COLOR} strokeWidth={t.width??.65}
          strokeLinecap="round" strokeLinejoin="round"
          points={(resolvedInk[t.id]?.points??t.points).map(p=>(p.x*100)+","+(p.y*100)).join(" ")}/>
      )}
    </svg>;
  }

  function renderChapterFlow(){
    const columnGap=Math.max(0,flowLayout.pageStep-flowLayout.contentWidth);
    const explicitMarks=markings.filter(item=>item.bookId===book.id&&item.chapterIndex===safeChapterIndex);
    const chapterMarkings=explicitMarks.flatMap(mark=>{
      const linked=mark.noteId?notes.find(note=>note.id===mark.noteId):undefined;
      if(linked&&!noteIsVisible(linked,activeReaderId))return [];
      const ranges=rangesForMark(mark);
      if(!ranges)return [];
      return [{...mark,ranges,authorId:mark.authorId??(linked?memberIdForNote(linked):"self")}];
    });
    const derivedNoteMarks=currentNotes.flatMap(note=>{
      if(explicitMarks.some(mark=>mark.noteId===note.id)||explicitMarks.some(mark=>
        !mark.noteId&&mark.quote===note.quote&&(mark.authorId??"self")===memberIdForNote(note)))return [];
      const ranges=rangesForNote(note);
      if(!ranges)return [];
      return [{id:"note:"+note.id,bookId:note.bookId,chapterIndex:note.chapterIndex,
        quote:note.quote,ranges,noteId:note.id,authorId:memberIdForNote(note)}];
    });
    const allChapterMarks=[...chapterMarkings,...derivedNoteMarks];
    const focusRanges=focusAnchor?.bookId===book.id&&focusAnchor.chapterIndex===safeChapterIndex
      ?focusAnchor.ranges:[];
    const rangesOverlap=(left:TextRange,right:TextRange)=>left.paragraphIndex===right.paragraphIndex&&
      left.start<right.end&&right.start<left.end;
    function markedParagraph(paragraph:string,paragraphIndex:number){
      const ranges=allChapterMarks.flatMap(mark=>mark.ranges
        .filter(range=>range.paragraphIndex===paragraphIndex)
        .map(range=>({...range,mark})));
      if(!ranges.length)return paragraph;
      const stops=[0,paragraph.length,...ranges.flatMap(range=>[range.start,range.end])]
        .filter(value=>value>=0&&value<=paragraph.length).sort((a,b)=>a-b)
        .filter((value,index,all)=>index===0||value!==all[index-1]);
      return stops.slice(0,-1).map((start,index)=>{
        const end=stops[index+1],content=paragraph.slice(start,end);
        const covering=ranges.filter(item=>item.start<=start&&item.end>=end)
          .map(item=>item.mark).filter((mark,index,all)=>all.findIndex(item=>item.id===mark.id)===index);
        if(!covering.length)return <span key={start+":"+end}>{content}</span>;
        const colors=[...new Set(covering.map(mark=>memberColors[mark.authorId??"self"]))];
        const focused=focusRanges.some(target=>covering.some(mark=>mark.ranges.some(range=>rangesOverlap(range,target))));
        const style={
          "--demo-mark-color":colors[0]??DEFAULT_MEMBER_COLORS.self,
          "--demo-mark-color-secondary":colors[1]??colors[0]??DEFAULT_MEMBER_COLORS.self,
        } as CSSProperties;
        return <span key={start+":"+end+":"+covering.map(mark=>mark.id).join(",")}
          className={"demo-quoted-mark"+(colors.length>1?" demo-quoted-mark-multi":"")+(focused?" demo-annotation-focus":"")}
          style={style} role="button" tabIndex={0} data-mark-count={covering.length}
          data-note-ids={covering.flatMap(mark=>mark.noteId?[mark.noteId]:[]).join(",")}
          aria-label={"查看这段文字的 "+covering.length+" 条批注："+content}
          onClick={()=>openMarkings(covering)} onKeyDown={event=>{
            if(event.key==="Enter"||event.key===" "){event.preventDefault();openMarkings(covering);}
          }}>{content}</span>;
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
          onSelect={e=>captureSelection(safeChapterIndex,e.currentTarget)}
          onTouchEnd={e=>captureSelection(safeChapterIndex,e.currentTarget)}>
          {chapter.paragraphs.map((paragraph,i)=><p key={i} data-paragraph-index={i}>
            {markedParagraph(paragraph,i)}</p>)}
        </div>
      </div>
    </div>;
  }
  function renderNote(item:DemoNote){
    const authorId=memberIdForNote(item);
    const accent=memberColors[authorId];
    const focused=focusedNoteIds.includes(item.id)||openNoteId===item.id;
    return <article key={item.id} className={"demo-note-card"+(focused?" demo-note-selected":"")}
      style={{"--demo-note-accent":accent} as CSSProperties}>
      <div className="demo-note-author">
        <span className="demo-mini-avatar" style={{backgroundColor:accent}}>
          {authorId==="self"?"我":"伴"}
        </span>
        <strong>{item.author}</strong>
        <span>{item.visibility==="private"?"仅自己可见":item.authorId?"双方可见":"演示批注"}</span>
        {authorId===activeReaderId&&<span className="demo-note-actions">
          <button type="button" className="demo-note-visibility-toggle"
            onClick={()=>toggleNoteVisibility(item.id)}
            aria-label={item.visibility==="private"?"将这条批注改为双方可见":"将这条批注改为仅自己可见"}>
            {item.visibility==="private"?"公开":"设为私密"}
          </button>
          <button type="button" className="demo-note-remove"
            onClick={()=>removeNote(item.id)} aria-label="删除我添加的这条演示批注">删除</button>
        </span>}
      </div>
      <blockquote role="button" tabIndex={0} aria-label="定位到这条批注的原文"
        onClick={()=>openNoteQuote(item)} onKeyDown={event=>{
          if(event.key==="Enter"||event.key===" "){event.preventDefault();openNoteQuote(item);}
        }}>“{item.quote}”</blockquote>
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
                {heroBook&&<small className="demo-hero-reading-state">
                  {heroCover.title} · 已读约 {heroProgress}%
                </small>}
                <button type="button" className="demo-hero-button"
                  onClick={()=>heroBook?openBook(heroBook.id):fileRef.current?.click()}>
                  {heroBook?"继续阅读":"导入第一本书"} <span>↗</span>
                </button>
              </div>
              <div className="demo-hero-art" aria-hidden="true">
                <div className="demo-art-halo"/>
                <div className="demo-art-book demo-art-back"><span className="demo-art-back-mark">✦</span><small>SHARED READING</small></div>
                <div className="demo-art-book demo-art-front">
                  <span className="demo-art-cover-title" style={{fontSize:`${heroCoverTitleSize}px`}}>{heroCover.title}</span>
                  {heroCover.author&&<small className="demo-art-cover-author">{heroCover.author}</small>}
                  {heroCover.translator&&<small className="demo-art-cover-translator">译 · {heroCover.translator}</small>}
                  <i>{heroBook?.edition??"ADD A BOOK"}</i>
                </div>
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
              <div className="demo-drawing-colors" aria-label="自由手绘颜色">
                {DRAWING_COLORS.map(color=><button key={color} type="button" className={drawingColor===color?"demo-drawing-color-selected":""}
                  aria-label={"选择手绘颜色 "+color} aria-pressed={drawingColor===color}
                  style={{backgroundColor:color}} onClick={()=>setDrawingColor(color)}/>) }
              </div>
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
                  {/* Keep an interactive layer over the right sheet even when
                   * it is the final blank page of a chapter. The paper is
                   * still a valid drawing surface and old strokes must not
                   * disappear merely because the page has no prose column. */}
                  {visiblePages===2&&renderInkLayer(pageOffset+1,1)}
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
                  <div className="demo-note-visibility" aria-label="批注可见范围">
                    <span>可见范围</span>
                    <button type="button" className={noteVisibility==="public"?"demo-choice-current":""}
                      aria-pressed={noteVisibility==="public"} onClick={()=>setNoteVisibility("public")}>双方可见</button>
                    <button type="button" className={noteVisibility==="private"?"demo-choice-current":""}
                      aria-pressed={noteVisibility==="private"} onClick={()=>setNoteVisibility("private")}>仅自己可见</button>
                  </div>
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
                setScreen("reader");openNoteQuote(item);
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
            <div className="demo-settings-row demo-annotation-color-row"><div><h2>文字批注身份颜色</h2>
              <p>颜色只用于识别文字批注作者；自由手绘颜色在阅读器工具栏中独立设置。</p></div>
              <div className="demo-identity-color-settings">
                <div className="demo-reader-identity-switch" aria-label="选择当前模拟读者">
                  <span>当前身份</span>
                  <button type="button" className={activeReaderId==="self"?"demo-choice-current":""}
                    aria-pressed={activeReaderId==="self"} onClick={()=>setActiveReaderId("self")}>我</button>
                  <button type="button" className={activeReaderId==="companion"?"demo-choice-current":""}
                    aria-pressed={activeReaderId==="companion"} onClick={()=>setActiveReaderId("companion")}>共读伙伴</button>
                </div>
                <div className="demo-annotation-color-grid" aria-label="预设批注颜色">
                  {ANNOTATION_COLORS.map(color=>{
                    const occupiedBy=activeReaderId==="self"?memberColors.companion:memberColors.self;
                    const selected=memberColors[activeReaderId]===color.value;
                    const disabled=occupiedBy===color.value;
                    return <button key={color.value} type="button" className={selected?"demo-annotation-color-selected":""}
                      disabled={disabled} aria-pressed={selected} aria-label={color.name+(disabled?"，共读伙伴已选择":"")}
                      title={disabled?"共读伙伴已选择":color.name}
                      onClick={()=>setMemberColors(old=>({...old,[activeReaderId]:color.value}))}>
                      <span style={{backgroundColor:color.value}}/><small>{color.name}</small>
                    </button>;
                  })}
                </div>
              </div>
            </div>
            <div className="demo-settings-row"><div><h2>导出本地备份</h2>
              <p>把书签、导入文字、批注和设置保存为明文 JSON。请勿在公用设备存储敏感文字。</p></div>
              <button type="button" className="demo-reset-button" onClick={saveExport}>下载 JSON 备份</button>
            </div>
            <div className="demo-settings-row"><div><h2>恢复演示</h2><p>删除这个浏览器里所有演示数据（不可撤销）。</p></div>
              <button type="button" className="demo-reset-button" onClick={()=>{
                if(!window.confirm("确定删除本地导入书籍、划线、手绘、批注和书签？无法恢复。"))return;
                localStorage.removeItem(DEMO_STORAGE_KEY);
                setBooks(seedBooks);setBookId("rain");setHasRecentBook(false);setChapterIndex(0);
                setNight(false);setFontSize(19);setDoublePage(true);setSaved([]);
                setProgress({});setPageProgress({});setPageOffset(0);setPageCount(1);
                setStrokes([]);setMarkings([]);setSelection(null);
                setNotes(initialNotes);setNoteDraft("");setOpenNoteId(null);setFocusedNoteIds([]);
                setMemberColors(DEFAULT_MEMBER_COLORS);setActiveReaderId("self");setNoteVisibility("public");
                setDrawingColor(DRAWING_COLORS[0]);
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
