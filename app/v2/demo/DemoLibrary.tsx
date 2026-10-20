"use client";

import { useRef, useState, type FormEvent } from "react";

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
};
type DemoNote = {
  id: string;
  bookId: string;
  chapterIndex: number;
  quote: string;
  content: string;
  author: "我" | "共读伙伴";
};

const books: DemoBook[] = [
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

const initialNotes: DemoNote[] = books.flatMap(book =>
  book.chapters.map((chapter, chapterIndex) => ({
    id: book.id + "-" + chapterIndex,
    bookId: book.id,
    chapterIndex,
    quote: chapter.marked,
    content: chapter.companionThought,
    author: "共读伙伴" as const,
  }))
);

const kinds = ["全部", "小说", "随笔", "旅行"] as const;

export function DemoLibrary() {
  const [screen,setScreen] = useState<"library"|"reader"|"notes"|"settings">("library");
  const [bookId,setBookId] = useState("rain");
  const [chapterIndex,setChapterIndex] = useState(0);
  const [kind,setKind] = useState<string>("全部");
  const [search,setSearch] = useState("");
  const [notes,setNotes] = useState<DemoNote[]>(initialNotes);
  const [noteDraft,setNoteDraft] = useState("");
  const [openNoteId,setOpenNoteId] = useState<string|null>(null);
  const [notesVisible,setNotesVisible] = useState(true);
  const [tocVisible,setTocVisible] = useState(false);
  const [night,setNight] = useState(false);
  const [fontSize,setFontSize] = useState(19);
  const [doublePage,setDoublePage] = useState(true);
  const [saved,setSaved] = useState<string[]>([]);
  const [notice,setNotice] = useState("");
  const noteSequence=useRef(0);

  const book=books.find(item=>item.id===bookId)??books[0];
  const chapter=book.chapters[chapterIndex];
  const saveKey=book.id+":"+chapterIndex;
  const bookmarked=saved.includes(saveKey);
  const currentNotes=notes.filter(item=>item.bookId===book.id && item.chapterIndex===chapterIndex);
  const allBookNotes=notes.filter(item=>item.bookId===book.id);
  const results=books.filter(item=>
    (kind==="全部"||item.kind===kind) &&
    (item.title+item.subtitle+item.author).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );
  const percent=Math.round((chapterIndex+1)/book.chapters.length*100);

  function navigate(next:"library"|"reader"|"notes"|"settings"){
    setScreen(next);setNotice("");
    if(next==="reader")setTocVisible(false);
  }
  function openBook(id:string){
    setBookId(id);setChapterIndex(0);setScreen("reader");
    setTocVisible(false);setOpenNoteId(null);setNoteDraft("");setNotesVisible(true);setNotice("");
  }
  function goChapter(index:number){
    if(index<0||index>=book.chapters.length)return;
    setChapterIndex(index);setOpenNoteId(null);setTocVisible(false);setNoteDraft("");setNotice("");
  }
  function toggleBookmark(){
    setSaved(current=>current.includes(saveKey)?current.filter(k=>k!==saveKey):[...current,saveKey]);
    setNotice(bookmarked?"已移除这页的演示书签。":"已在当前页放入演示书签。");
  }
  function saveNote(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const body=noteDraft.trim();
    if(body.length<2)return;
    const note:DemoNote={
      id:"me-"+(++noteSequence.current),
      bookId:book.id,
      chapterIndex,
      quote:chapter.marked,
      content:body.slice(0,240),
      author:"我",
    };
    setNotes(current=>[...current,note]);
    setOpenNoteId(note.id);setNotesVisible(true);setNoteDraft("");
    setNotice("这条批注只保存在当前演示页面中，刷新后会还原。");
  }
  function removeNote(id:string){
    const item=notes.find(x=>x.id===id);
    if(item?.author!=="我")return;
    setNotes(current=>current.filter(x=>x.id!==id));
    if(openNoteId===id)setOpenNoteId(null);
    setNotice("已从演示界面移除这条批注。");
  }
  function renderChapter(index:number,secondary=false){
    const section=book.chapters[index];
    if(!section)return null;
    const linkedNote=notes.find(x=>x.bookId===book.id && x.chapterIndex===index && x.author==="共读伙伴");
    return (
      <article className={"demo-paper-page"+(secondary?" demo-paper-page-next":"")}
        key={book.id+":"+index} aria-label={section.name}>
        <div className="demo-chapter-ornament">✧</div>
        <div className="demo-chapter-kicker">{section.kicker}</div>
        <h2 className="demo-chapter-name">{section.name}</h2>
        <div className="demo-prose" style={{fontSize:fontSize+"px"}}>
          {section.paragraphs.map((paragraph,i)=>{
            const start=paragraph.indexOf(section.marked);
            if(start<0)return <p key={i}>{paragraph}</p>;
            return <p key={i}>
              {paragraph.slice(0,start)}
              <button type="button" className="demo-quoted-mark"
                aria-label={"查看共读伙伴对这句话的批注："+section.marked}
                onClick={()=>{
                  setOpenNoteId(linkedNote?.id??null);
                  setNotesVisible(true);
                  setNotice("你点开了一处演示划线。右侧可以查看共读伙伴的想法。");
                }}>{section.marked}</button>
              {paragraph.slice(start+section.marked.length)}
            </p>;
          })}
        </div>
        <div className="demo-paper-footer">
          <span>SHARED READING ROOM</span>
          <span>{String(index+1).padStart(2,"0")} / {String(book.chapters.length).padStart(2,"0")}</span>
        </div>
      </article>
    );
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
    </article>;
  }

  return (
    <div className={"demo-app"+(night?" demo-night":"")}>
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
            <strong>{screen==="library"?"我的书架":screen==="reader"?book.title:screen==="notes"?"共读批注":"阅读设置"}</strong>
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
              {results.map(item=><button key={item.id} type="button" className="demo-book-card"
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
              </button>)}
              {results.length===0&&<p className="demo-empty-search">没有符合条件的演示书籍。试试其他关键词。</p>}
            </div>
            <div className="demo-bottom-tip"><span>✦</span>
              书名、正文、伙伴在线状态都是原创模拟内容。这里不会连接数据库或访问你的真实书籍。
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
                <button type="button" className="demo-icon-action" aria-expanded={tocVisible}
                  onClick={()=>setTocVisible(x=>!x)}>☷ <span>目录</span></button>
                <button type="button" className="demo-icon-action" aria-pressed={notesVisible}
                  onClick={()=>setNotesVisible(x=>!x)}>✎ <span>批注</span></button>
                <button type="button" className="demo-icon-action" onClick={()=>navigate("settings")}>⚙ <span>设置</span></button>
              </div>
            </div>

            {tocVisible&&<div className="demo-toc">
              <div><strong>章节目录</strong><span>{book.chapters.length} CHAPTERS</span></div>
              {book.chapters.map((c,i)=><button key={c.name} type="button"
                className={i===chapterIndex?"demo-toc-active":""} onClick={()=>goChapter(i)}>
                <span>{String(i+1).padStart(2,"0")}</span> {c.name} {i===chapterIndex?"· 正在读":""}
              </button>)}
            </div>}

            <div className="demo-reading-layout">
              <div className="demo-book-column">
                <div className={"demo-pages"+(doublePage?" demo-pages-spread":"")}>
                  {renderChapter(chapterIndex)}
                  {doublePage&&chapterIndex+1<book.chapters.length&&renderChapter(chapterIndex+1,true)}
                </div>
                <div className="demo-page-navigation">
                  <button type="button" disabled={chapterIndex===0}
                    onClick={()=>goChapter(chapterIndex-1)}>‹ <span>上一章</span></button>
                  <div className="demo-reader-progress">
                    <div className="demo-progress-track"><span style={{width:percent+"%"}}/></div>
                    <div className="demo-progress-label">已读 {percent}% · {chapterIndex+1}/{book.chapters.length}</div>
                  </div>
                  <button type="button" disabled={chapterIndex===book.chapters.length-1}
                    onClick={()=>goChapter(chapterIndex+1)}><span>下一章</span> ›</button>
                </div>
              </div>
              {notesVisible&&<aside className="demo-annotation-aside" aria-label="当前章节共读批注">
                <div className="demo-aside-heading"><span>IN THE MARGINS</span><h2>页边的对话 <sup>{currentNotes.length}</sup></h2></div>
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
                <p className="demo-aside-warning">仅为模拟互动，刷新页面后不保留。</p>
              </aside>}
            </div>
          </main>
        )}

        {screen==="notes"&&<main className="demo-content demo-narrow-content">
          <span className="demo-section-overline">THOUGHTS & HIGHLIGHTS</span>
          <h1 className="demo-page-title">那些想留下的句子。</h1>
          <p className="demo-page-description">一段文字，两种读法。这里展示刚刚那本书的演示批注和你在本次访问中添加的想法。</p>
          <label className="demo-book-pick">选择演示书籍
            <select value={bookId} onChange={e=>setBookId(e.target.value)}>
              {books.map(item=><option value={item.id} key={item.id}>{item.title}</option>)}
            </select>
          </label>
          <div className="demo-notes-list">
            {allBookNotes.map(item=><div className="demo-notes-list-item" key={item.id}>
              {renderNote(item)}
              <button type="button" onClick={()=>{
                setChapterIndex(item.chapterIndex);setScreen("reader");
                setOpenNoteId(item.id);setNotesVisible(true);
              }}>前往第 {item.chapterIndex+1} 章 →</button>
            </div>)}
            {allBookNotes.length===0&&<p>还没有批注，先去读一章吧。</p>}
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
                  onChange={event=>setFontSize(Number(event.target.value))} aria-label="正文字号"/>
                <strong>{fontSize}px</strong>
              </label>
            </div>
            <div className="demo-settings-row"><div><h2>桌面双页</h2><p>宽屏可以同时看到下一章，小屏自动单页。</p></div>
              <button type="button" className={"demo-toggle"+(doublePage?" demo-toggle-on":"")}
                role="switch" aria-checked={doublePage} aria-label="桌面双页模式"
                onClick={()=>setDoublePage(x=>!x)}><span/></button>
            </div>
            <div className="demo-settings-row"><div><h2>恢复演示</h2><p>清除本次访问临时添加的批注、书签及偏好。</p></div>
              <button type="button" className="demo-reset-button" onClick={()=>{
                setNight(false);setFontSize(19);setDoublePage(true);setSaved([]);
                setNotes(initialNotes);setNoteDraft("");setOpenNoteId(null);
                setNotice("演示已恢复初始状态。");
              }}>重置演示数据</button>
            </div>
          </section>
          <button type="button" className="demo-return-to-book" onClick={()=>navigate("reader")}>← 返回阅读界面</button>
        </main>}

        {notice&&<div className="demo-notice" role="status">
          <span>{notice}</span><button type="button" onClick={()=>setNotice("")} aria-label="关闭提示">×</button>
        </div>}
        <footer className="demo-global-footer"><span>© SHARED LIBRARY · DESIGN PREVIEW</span><span>模拟内容 · 无需登录 · 不保存数据</span></footer>
      </div>
    </div>
  );
}
