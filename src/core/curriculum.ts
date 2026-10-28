/**
 * 钢琴入门课程 —— 从「键盘上有几个键」教到「弹完一首完整的独奏」。
 *
 * 三条设计原则，改内容前先读：
 *
 * 1) 每课**必须有可弹的东西**。纯读文字学不会琴，所以除第 1 课的自由探索外，
 *    每课都带一段练习曲，而且练习曲就是本应用自己的乐谱 IR ——
 *    学生练的谱子，可以立刻拿到卷帘里改、混音台里换音色、导出成 MIDI 给别人。
 *    这是它跟「看视频学琴」的根本区别：学的工具就是做的工具。
 *
 * 2) 练习曲写成 ABC 再走自家的严格解析器，不手搓 Note 数组。
 *    理由和 demo.ts 一样：一份课程同时是解析器的活样本。课程 28 段谱子里
 *    只要有一段解析不出来，verification 立刻报红（见 scripts/verify.ts 的课程段）。
 *
 * 3) 讲解只讲「这一课真的要用的东西」，不铺百科。
 *    每段正文配一条 tip，写的是初学者实际会错的地方（数错线、按错键、
 *    左手抢拍），不是「音乐是美妙的」这类正确而无用的话。
 *
 * 数据与界面分离：这个文件不 import 任何 React，Node 下可直接跑测试。
 */

import { parseAbc } from "./abc.ts";
import { beatsPerMeasure, measureCount, type Score } from "./model.ts";

/* ================================================================ 类型 */

export interface BriefBlock {
  /** 小标题（可省） */
  h?: string;
  /** 正文，一句一段更好读 */
  body: string;
  /** 易错点 / 练习提示，界面用强调色单独画一条 */
  tip?: string;
}

export interface Practice {
  /** 练习曲 ABC。缺省表示这节课只有讲解（如最后一课的导出实操） */
  abc?: string;
  /** 判定用哪条轨：0 = 右手 / 主旋律。左手练习课设为对应的轨 */
  judgeTrack?: number;
  /** 自由探索：不判定对错，按键即发声、显示音名 */
  free?: boolean;
  /** 建议速度。练习时按这个跑节拍器 */
  bpm: number;
  /** 通关准确率（0-1）。0.8 = 允许每 5 个音错 1 个 */
  pass: number;
  /** 通关条件的人话说明 */
  passHint: string;
  /** 屏幕琴键范围 [最低音, 最高音]；缺省按练习曲音域自动取 */
  keys?: [number, number];
  /** 这条练习的重点，练习中显示在琴键上方 */
  focus?: string;
}

export interface Lesson {
  /** 全局唯一，格式 c<章>-<课>，如 c3-2。进度按这个键存 */
  id: string;
  title: string;
  /** 一句话：学完这节课你能做什么 */
  goal: string;
  /** 预计分钟（诚实估计，包含反复练的时间） */
  minutes: number;
  brief: BriefBlock[];
  practice?: Practice;
  /** 通关后给的一句话总结 */
  takeaway?: string;
}

export interface Chapter {
  id: string;
  title: string;
  subtitle: string;
  lessons: Lesson[];
}

/* ================================================================ 课程 */

export const CHAPTERS: Chapter[] = [
  {
    id: "c1",
    title: "第 1 章 · 先认识这台机器",
    subtitle: "不急着弹曲子。先搞清楚 88 个键是怎么排的、C 在哪、手指怎么站。",
    lessons: [
      {
        id: "c1-1",
        title: "键盘是 12 个音一组循环",
        goal: "说清白键与黑键的排列规律，知道为什么黑键是「两个一组、三个一组」交替。",
        minutes: 8,
        brief: [
          {
            h: "从黑键开始看，比从白键容易",
            body: "钢琴上白键多、黑键少，但真正划分结构的是黑键。你顺着键盘看：两个黑键、三个黑键、两个黑键、三个黑键……一直交替到右边。",
          },
          {
            h: "一组 = 12 个键",
            body: "「两个黑键 + 三个黑键 + 夹在它们之间的 7 个白键」这段，就是 12 个半音，也就是一个八度。整台琴就是这一组不断重复，越往右声音越高。",
            tip: "标准钢琴 88 个键 = 7 个完整八度 + 两端各多几个音。你不需要背这个数字，只要认得出「一组」在哪里开始。",
          },
          {
            h: "现在动手",
            body: "下面的琴键是自由的：随便按，按到哪里都会响，并且会告诉你这个键叫什么。先用手把整片键盘摸一遍，听低音和高音的区别。",
            tip: "左侧的键声音低而厚，右侧高而亮。同一个键用力按会响一点，但音高不会变 —— 这是钢琴和吉他的重要区别。",
          },
        ],
        practice: {
          free: true,
          bpm: 80,
          pass: 0,
          passHint: "自由探索：随便按，按过 12 个不同的键就算摸过一遍。",
          keys: [48, 84],
          focus: "按一按：听低音区和高音区的区别",
        },
        takeaway: "黑键两两一组、三三一组交替；一组 12 个键就是一个八度，整台琴是它的重复。",
      },
      {
        id: "c1-2",
        title: "找到 C：两个黑键的左边",
        goal: "在任意位置一眼找到 C，并区分 C3、C4、C5 是不同高度的同一个音名。",
        minutes: 8,
        brief: [
          {
            h: "一个动作就能定位",
            body: "看那两个靠在一起的黑键，紧挨着它们**左边**的那个白键，就是 C。整台琴上每一个「两个黑键」的左边都有一个 C。",
          },
          {
            h: "为什么先找 C",
            body: "因为乐理里所有的距离都是从 C 数起的。你知道 C 在哪，剩下的音名（D E F G A B）就是往右一个个数过去。",
            tip: "常见的错：把三个黑键左边的白键也当成 C。三个黑键左边是 F。认错了整条音阶都会偏。",
          },
          {
            h: "中央 C 是哪个",
            body: "钢琴中间那个 C 叫中央 C，记作 C4。往右一个八度是 C5，往左一个是 C3。它们音名一样，只是高度不同 —— 所以谱子上要用不同的位置来画。",
          },
        ],
        practice: {
          abc: `X:1
T:找到三个 C
M:4/4
L:1/4
Q:1/4=72
K:C
C,4 | C4 | c4 |
`,
          bpm: 72,
          pass: 0.9,
          passHint: "按顺序弹出低音 C、中央 C、高音 C。三个都对就过关。",
          keys: [48, 72],
          focus: "低音 C → 中央 C → 高音 C，注意它们在琴键上的位置差别",
        },
        takeaway: "C 永远躲在「两个黑键」的左边。C3 / C4 / C5 是同一个音名在不同高度。",
      },
      {
        id: "c1-3",
        title: "音名与唱名",
        goal: "把 C D E F G A B 和 do re mi fa sol la si 对上号。",
        minutes: 6,
        brief: [
          {
            h: "两套叫法，同一堆音",
            body: "音名是 C D E F G A B，写谱、说调都用它；唱名是 do re mi fa sol la si，唱旋律时用它。它们是同一组音的两种叫法，不是两套体系。",
          },
          {
            h: "对着数一遍",
            body: "C=do，D=re，E=mi，F=fa，G=sol，A=la，B=si，然后回到高八度的 C=do。",
            tip: "F 和 B 之间是半音（相邻两个键），其余相邻音名之间都是全音（隔一个键）。这一点决定了后面所有音阶的样子。",
          },
        ],
        practice: {
          abc: `X:1
T:C 大调音阶（上行）
M:4/4
L:1/4
Q:1/4=72
K:C
C D E F | G A B c |
`,
          bpm: 72,
          pass: 0.85,
          passHint: "从中央 C 一路弹到高音 C，一个音一拍。允许错 1 个。",
          keys: [60, 72],
          focus: "一边弹一边念 do re mi fa sol la si do",
        },
        takeaway: "C D E F G A B = do re mi fa sol la si，其中 E–F、B–C 是半音。",
      },
      {
        id: "c1-4",
        title: "手指编号与手型",
        goal: "记住 1 到 5 指分别是哪根手指，并能在 C 位把手放稳。",
        minutes: 10,
        brief: [
          {
            h: "编号从拇指开始",
            body: "两只手都是：1 = 拇指，2 = 食指，3 = 中指，4 = 无名指，5 = 小指。左手右手编号一样，只是方向相反。",
          },
          {
            h: "C 位：五个手指各占一个白键",
            body: "右手把 1 指放在中央 C 上，那么 2 指自然落到 D，3 指 E，4 指 F，5 指 G。这个姿势叫 C 位，是入门阶段九成的练习曲的起点。",
            tip: "手指要立起来、用指尖触键，掌关节别塌。手腕低于琴键时，4、5 指会按不动 —— 手腕略高一点。",
          },
          {
            h: "4 指和 5 指是最弱的",
            body: "它们天生力气小，一开始声音会明显比其他手指轻。这不是你的问题，所有人都这样。练习时故意让 4、5 指多使一点力，让五个音听起来一样响。",
          },
        ],
        practice: {
          abc: `X:1
T:C 位五指上下行
M:4/4
L:1/4
Q:1/4=72
K:C
C D E F | G4 | G F E D | C4 |
`,
          bpm: 72,
          pass: 0.85,
          passHint: "用 1-2-3-4-5 指上行，再 5-4-3-2-1 下行。手指不要离开琴键太远。",
          keys: [60, 67],
          focus: "1 2 3 4 5 上行，5 4 3 2 1 下行 —— 尽量让五个音一样响",
        },
        takeaway: "1=拇指到 5=小指；C 位是 1 指在 C4，五根手指各占一个白键。",
      },
    ],
  },
  {
    id: "c2",
    title: "第 2 章 · 把声音写成符号",
    subtitle: "五线谱的五条线、中央 C 的位置、音符值几拍 —— 这一章解决「看谱」这件事。",
    lessons: [
      {
        id: "c2-1",
        title: "五条线、四个间，从下往上数",
        goal: "看到谱上的音能说出它在第几线或第几间。",
        minutes: 10,
        brief: [
          {
            h: "线比间大",
            body: "五线谱是五条横线，线之间夹出四个空白，叫「间」。数法一律从下往上：最下面一条是第 1 线，最上面是第 5 线；最下面的空白是第 1 间。",
          },
          {
            h: "高音谱号的圈圈锁住 G",
            body: "谱号那一团圈的起点，绕的就是第 2 线，而第 2 线就是 G。所以高音谱号也叫 G 谱号。知道 G 在第 2 线，其余的音顺着线间往上数就行。",
            tip: "数错方向是最常见的错误：五线谱的音高是从下往上变高的。手指在谱上要从下往上移，眼睛也别偷懒从上往下扫。",
          },
          {
            h: "第 1 线是 E",
            body: "高音谱号下，第 1 线 = E4，第 1 间 = F4，第 2 线 = G4，第 2 间 = A4，第 3 线 = B4，第 3 间 = C5。记住「1 线 E、2 线 G、3 线 B」这三个就够起步了。",
          },
        ],
        practice: {
          abc: `X:1
T:第 1 线、第 2 线、第 3 线
M:4/4
L:1/4
Q:1/4=66
K:C
E4 | G4 | B4 |
`,
          bpm: 66,
          pass: 0.9,
          passHint: "三个音各按一次，顺序是 E → G → B（一线、二线、三线）。",
          keys: [64, 71],
          focus: "看谱上音符的位置：一线、二线、三线",
        },
        takeaway: "五线四间从下往上数；高音谱号第 2 线是 G，1/2/3 线是 E/G/B。",
      },
      {
        id: "c2-2",
        title: "中央 C 站在下加一线",
        goal: "认出下加一线的中央 C，并顺着数到它上方的四个音。",
        minutes: 8,
        brief: [
          {
            h: "谱子下面的那条短线",
            body: "五线谱最下面还有一条短短的横线，叫「下加一线」。中央 C（C4）就画在它上面。这是初学者第一个要背下来的位置，因为几乎所有入门曲都从它开始。",
          },
          {
            h: "从 C 往上数",
            body: "下加一线 C4、下加一间 D4、第 1 线 E4、第 1 间 F4、第 2 线 G4。每上一个位置，音就高一级。",
            tip: "线→间→线→间 是连续的音级，不要跳。看到音符贴着线画就是线上的音，悬在两线之间就是间里的音。",
          },
        ],
        practice: {
          abc: `X:1
T:从中央 C 往上四个音
M:4/4
L:1/4
Q:1/4=66
K:C
C2 D2 | E2 F2 |
`,
          bpm: 66,
          pass: 0.9,
          passHint: "C D E F，每个音两拍。注意第 1、2 个音在谱子下方（下加线/下加间）。",
          keys: [60, 65],
          focus: "下加一线 C、下加一间 D、第 1 线 E、第 1 间 F",
        },
        takeaway: "中央 C 在下加一线；往上依次是 D（下加一间）、E（第 1 线）、F（第 1 间）。",
      },
      {
        id: "c2-3",
        title: "音符值几拍",
        goal: "分清全音符、二分音符、四分音符，并按拍子弹出来。",
        minutes: 12,
        brief: [
          {
            h: "看符头是不是空的、有没有符干",
            body: "全音符是一个空心圆，没有符干，值 4 拍；二分音符是空心圆加一根符干，值 2 拍；四分音符是实心圆加符干，值 1 拍。再往下的八分音符会有符尾，值半拍。",
          },
          {
            h: "拍子怎么数",
            body: "4/4 拍的意思是：每小节 4 拍，以四分音符为一拍。数的时候嘴里念 1-2-3-4，一个四分音符占一个数。全音符要占满四个数：1-2-3-4 期间一直按着不放。",
            tip: "初学者最常见的错是「弹完就松手」—— 全音符按一下就抬手，听起来变成四分音符，节拍就散了。要数着拍子保持住。",
          },
        ],
        practice: {
          abc: `X:1
T:一个音的四种时值
M:4/4
L:1/4
Q:1/4=60
K:C
C4 | C2 C2 | C C C C |
`,
          bpm: 60,
          pass: 0.9,
          passHint: "第 1 小节一个音保持 4 拍；第 2 小节两个音各 2 拍；第 3 小节四个音各 1 拍。",
          keys: [60, 60],
          focus: "全是同一个 C —— 变的只是按住多久",
        },
        takeaway: "全音符 4 拍、二分 2 拍、四分 1 拍；4/4 拍每小节刚好 4 个四分音符。",
      },
      {
        id: "c2-4",
        title: "八分音符：一拍两个音",
        goal: "在 4/4 的一小节里均匀弹出 8 个八分音符。",
        minutes: 12,
        brief: [
          {
            h: "符尾把它们绑在一起",
            body: "八分音符是实心符头 + 符干 + 一条符尾。谱上相邻的八分音符通常用一条横线（符杠）连起来，看着像两个连体音 —— 那就是「一拍里的两个音」。",
          },
          {
            h: "数 & ，不要数得更快",
            body: "一拍分成两半，一半叫「&」（读「安」）。数法变成 1-&-2-&-3-&-4-&，八个位置正好八个八分音符。心里跟着节拍器走，不要因为音多了就整体加速。",
            tip: "八分音符最容易犯的错是越弹越快。开节拍器，把速度降到 60 甚至 50，宁可慢而匀，也不要快而乱。",
          },
        ],
        practice: {
          abc: `X:1
T:八分音符音阶
M:4/4
L:1/4
Q:1/4=60
K:C
C/2 D/2 E/2 F/2 G/2 A/2 B/2 c/2 | c4 |
`,
          bpm: 60,
          pass: 0.85,
          passHint: "第 1 小节 8 个音要一样匀，第 2 小节收一个长音。",
          keys: [60, 72],
          focus: "心里数 1-&-2-&-3-&-4-&，每个位置一个键",
        },
        takeaway: "八分音符 = 半拍；4/4 一小节 8 个，数法 1-&-2-&-3-&-4-&。",
      },
    ],
  },
  {
    id: "c3",
    title: "第 3 章 · 右手弹出第一句旋律",
    subtitle: "从五指练习到《玛丽有只小羊羔》《小星星》—— 这一章结束时你能完整弹一段旋律。",
    lessons: [
      {
        id: "c3-1",
        title: "五指位上下行",
        goal: "手不离键地在 C 位弹出上下行，声音连贯不断。",
        minutes: 10,
        brief: [
          {
            h: "为什么第一个练习都是音阶",
            body: "音阶把「五个手指各管一个键」这件事练成本能。等你的手记住位置，眼睛就能离开琴键去看谱子 —— 这才是能不能视奏的分水岭。",
          },
          {
            h: "连贯：后一个音落下时前一个才松开",
            body: "连贯（legato）的秘密是「交接」：按 2 指的时候，1 指还按着，等 2 指发出声音了，1 指才松开。听起来像一条不断的线，而不是一颗颗断掉的珠子。",
            tip: "断奏和连贯的最大区别不在速度，在手有没有重叠的那一瞬。慢练时特别注意两个音之间有没有空隙。",
          },
        ],
        practice: {
          abc: `X:1
T:五指位上下行
M:4/4
L:1/4
Q:1/4=72
K:C
C D E F | G F E D | C4 |
`,
          bpm: 72,
          pass: 0.9,
          passHint: "上行再接下行，中间不要停。最后一个 C 保持 4 拍。",
          keys: [60, 67],
          focus: "手指不离键，音与音之间不留空隙",
        },
        takeaway: "连贯靠「后音落下、前音才松」的交接，不是靠弹得快。",
      },
      {
        id: "c3-2",
        title: "《玛丽有只小羊羔》",
        goal: "不看键盘完整弹出 8 小节旋律。",
        minutes: 15,
        brief: [
          {
            h: "这首曲子只用三个音",
            body: "全曲只在 E、D、C 三个音上打转，正好是 C 位的 3、2、1 指。它是世界上几乎所有钢琴教材的第一首曲子，因为它把「读谱」和「动手」的难度都压到最低。",
          },
          {
            h: "节奏的形状",
            body: "注意第 2、3 小节末尾的二分音符 —— 那里是呼吸点，句子在这里断一下，再接着走。不要把二分音符也弹成一拍，那样整首会显得着急。",
            tip: "第 4 小节的 G 是全曲最高的音，用 5 指。很多人这里会下意识把手腕抬起来去够，其实只要 5 指立住，G 就在原地。",
          },
        ],
        practice: {
          abc: `X:1
T:玛丽有只小羊羔
M:4/4
L:1/4
Q:1/4=72
K:C
E D C D | E E E2 | D D D2 | E G G2 |
E D C D | E E E E | D D E D | C4 |
`,
          bpm: 72,
          pass: 0.85,
          passHint: "8 小节连着弹完，中途不要停下来找键。允许错 2 个音。",
          keys: [60, 67],
          focus: "只用 3、2、1、5 指；二分音符要真的数满两拍",
        },
        takeaway: "三个音的曲子也能好听，关键是二分音符别抢拍。",
      },
      {
        id: "c3-3",
        title: "乐句与呼吸",
        goal: "听懂「四小节一句」，并在句尾留出呼吸。",
        minutes: 10,
        brief: [
          {
            h: "音乐也有标点",
            body: "四个小节通常构成一个乐句，相当于一句话。句尾常落在长音上 —— 那个长音就是逗号，弹到这里手腕轻轻提一下，再进下一句。",
          },
          {
            h: "《小星星》前两句",
            body: "C C G G | A A G2 | 是第一句（落回 G 的长音），F F E E | D D C2 | 是第二句（落回 C，收住了）。第一句悬着，第二句落地，这就是「问答」。",
            tip: "如果每一句都弹得一样重，听起来就像念课文不带标点。句尾那个长音稍微轻一点，句子感立刻就出来了。",
          },
        ],
        practice: {
          abc: `X:1
T:小星星（前两句）
M:4/4
L:1/4
Q:1/4=80
K:C
C C G G | A A G2 | F F E E | D D C2 |
`,
          bpm: 80,
          pass: 0.9,
          passHint: "四小节一句。句尾的二分音符保持两拍，再换气进下一句。",
          keys: [60, 69],
          focus: "第 2 小节末和第 4 小节末是呼吸点",
        },
        takeaway: "四小节一句；句尾落在长音上，抬手换气再进下一句。",
      },
      {
        id: "c3-4",
        title: "《小星星》主题完整版",
        goal: "完整弹出 8 小节主题，速度稳定、句子清楚。",
        minutes: 18,
        brief: [
          {
            h: "8 小节其实是两段",
            body: "前 4 小节是主题（落回 C），后 4 小节换了高一点的位置（G G F F | E E D2），最后还要回到主题。这一段的作用是把情绪抬起来再放下。",
          },
          {
            h: "第 5 小节是整首的技术点",
            body: "从第 4 小节的 D 直接跳到第 5 小节的 G，5 指要接住。这是全曲唯一一次「跨指」，慢练时单独把这两小节连起来练十遍。",
            tip: "跨指时手腕不要僵。手指够不到就用手腕带着手平移一点点，但不要整只手跳起来 —— 跳起来会断句。",
          },
        ],
        practice: {
          abc: `X:1
T:小星星（主题 8 小节）
M:4/4
L:1/4
Q:1/4=80
K:C
C C G G | A A G2 | F F E E | D D C2 |
G G F F | E E D2 | G G F F | E E D2 |
`,
          bpm: 80,
          pass: 0.85,
          passHint: "8 小节一口气弹完。第 4→5 小节是难点，可以单独先练这两小节。",
          keys: [60, 69],
          focus: "第 4 小节 D → 第 5 小节 G，5 指接住",
        },
        takeaway: "主题 8 小节 = 前半落在 C、后半抬到 G 再落回，跨指在中间。",
      },
    ],
  },
  {
    id: "c4",
    title: "第 4 章 · 左手：让音乐有地基",
    subtitle: "低音谱号、三和弦、最常见的四个和弦进行 —— 左手不是陪衬，它决定曲子立不立得住。",
    lessons: [
      {
        id: "c4-1",
        title: "低音谱号在下面那行",
        goal: "看懂低音谱号，找到低音区的 C。",
        minutes: 10,
        brief: [
          {
            h: "钢琴谱是两行叠起来的",
            body: "上面一行高音谱号给右手，下面一行低音谱号给左手。中间空出来的那条位置，正好是中央 C —— 所以两行合起来才是一台完整的钢琴。",
          },
          {
            h: "低音谱号的 F 在第 4 线",
            body: "低音谱号（F 谱号）那两个点夹住的线是第 4 线，那就是 F3。往下数：第 3 间 E3、第 3 线 D3、第 2 间 C3。低音 C 就在这里。",
            tip: "低音谱号不要用高音谱号的方式数 —— 两套位置完全不同。初学时宁可多花三天，也要把两行分开练熟。",
          },
        ],
        practice: {
          abc: `X:1
T:低音区的 C 与 G
M:4/4
L:1/4
Q:1/4=66
K:C
C,2 G,2 | C,4 |
`,
          bpm: 66,
          pass: 0.9,
          passHint: "左手弹低音 C3 和 G3，再回到 C3。用 5 指和 1 指。",
          keys: [48, 55],
          focus: "左手 5 指在 C3、1 指在 G3",
        },
        takeaway: "低音谱号第 4 线是 F3，往下数到第 2 间就是 C3。",
      },
      {
        id: "c4-2",
        title: "三个音一起：C 大三和弦",
        goal: "用三根手指同时按下 C、E、G，声音要像一个音一样齐。",
        minutes: 12,
        brief: [
          {
            h: "和弦 = 隔一个键按一个",
            body: "C 大三和弦是 C、E、G。在琴键上看：按 C，跳过 C#，按 E，跳过 F，按 G。三个音之间各隔一个键，这就是「三度叠置」。",
          },
          {
            h: "齐，比响更重要",
            body: "三个手指如果落下的时间差几毫秒，听起来就是「咕噜」一声而不是一个和弦。慢练时听那一下有没有杂音 —— 有杂音就是没对齐。",
            tip: "手腕要放松、略高于琴键，用手腕一点点的重量把三个键同时压下去。手指一根根去戳，永远对齐不了。",
          },
        ],
        practice: {
          abc: `X:1
T:C 大三和弦
M:4/4
L:1/4
Q:1/4=60
K:C
[CEG]4 | [CEG]4 |
`,
          bpm: 60,
          pass: 0.9,
          passHint: "两个全音符和弦，每小节一次。三个音必须同时响。",
          keys: [60, 67],
          focus: "1、3、5 指同时落下，听有没有杂音",
        },
        takeaway: "大三和弦 = 根音 + 隔一个键 + 再隔一个键；齐是风格，响只是音量。",
      },
      {
        id: "c4-3",
        title: "C – F – G – C：最常用的进行",
        goal: "左手连续弹完四个和弦，换和弦时不拖拍。",
        minutes: 15,
        brief: [
          {
            h: "四个和弦走完一个循环",
            body: "C（C-E-G）→ F（F-A-C）→ G（G-B-D）→ C。这四个和弦能配上千首流行歌和儿歌，因为它们分别是「主、下属、属、主」—— 出发、离开、拉紧、回家。",
          },
          {
            h: "换和弦要「提前想」",
            body: "不要等弹完这个小节才想起来下一个小节要换。在最后一拍就开始把手指挪到下一个和弦的位置，落下时才不慌。",
            tip: "F 和弦容易漏掉最上面的 C。它和 C 和弦的手指位置只差一个键，很多人手型没变过去就按，结果弹成了另一个和弦。",
          },
        ],
        practice: {
          abc: `X:1
T:C-F-G-C 进行
M:4/4
L:1/4
Q:1/4=60
K:C
[CEG]4 | [CFA]4 | [GBd]4 | [CEG]4 |
`,
          bpm: 60,
          pass: 0.85,
          passHint: "四个小节四个和弦，每小节一次。换和弦不许停拍。",
          keys: [60, 74],
          focus: "C → F → G → C，每次换和弦提前一拍准备",
        },
        takeaway: "C–F–G–C = 主–下属–属–主，是流行与儿歌的万能循环。",
      },
      {
        id: "c4-4",
        title: "左手分解：根音 + 五音",
        goal: "用左手弹出有推进感的低音走动，而不是每小节砸一下。",
        minutes: 15,
        brief: [
          {
            h: "把和弦拆开就流动了",
            body: "一直按和弦会显得笨重。改成「根音 - 五音」交替：C 和弦弹 C 和 G，F 和弦弹 F 和 C，G 和弦弹 G 和 D。声音马上有了走路的感觉。",
          },
          {
            h: "左手要稳、要轻",
            body: "左手的任务是铺地基，不是抢戏。它的音量应该明显小于右手旋律（工具里混音台可以把左手轨拉到 60% 左右）。",
            tip: "左手最常见的毛病是越来越快、越来越响。练的时候刻意压住音量，只用一半的力气。",
          },
        ],
        practice: {
          abc: `X:1
T:左手根音-五音
M:4/4
L:1/4
Q:1/4=66
K:C
C,2 G,2 | F,2 C,2 | G,2 D,2 | C,2 C,2 |
`,
          bpm: 66,
          pass: 0.85,
          passHint: "左手四个小节，每小节两个二分音符。注意保持均匀。",
          keys: [48, 62],
          focus: "根音与五音交替，音量只要右手的一半",
        },
        takeaway: "分解低音（根音+五音）比柱式和弦更有推进感，但要弹得轻。",
      },
    ],
  },
  {
    id: "c5",
    title: "第 5 章 · 两只手合起来",
    subtitle: "双手配合是入门最大的一道坎。这一章把它拆成四小步，一步只加一个难度。",
    lessons: [
      {
        id: "c5-1",
        title: "右手旋律 + 左手每小节一个音",
        goal: "双手同时弹，左手每小节只按一个根音。",
        minutes: 20,
        brief: [
          {
            h: "先练左手，再练右手，最后合",
            body: "不要一上来就双手合。正确顺序：左手单独练到不用看（10 遍）→ 右手单独练到不用看（10 遍）→ 双手合，速度降到一半。",
          },
          {
            h: "左手只按一个音，为什么还难",
            body: "难的不是左手，是两只手要同时开始、同时换。左手每小节第一拍按下时，右手正好也在弹那一拍的音 —— 两个动作要黏在一起。",
            tip: "合手时先只对「每小节第一拍」，把中间的音先忽略。等第一拍对上了，中间的音自然就归位了。",
          },
        ],
        practice: {
          abc: `X:1
T:小星星（右手 + 左手根音）
M:4/4
L:1/4
Q:1/4=60
%%score {1 2}
K:C
V:1 name="右手" clef=treble
C C G G | A A G2 | F F E E | D D C2 |
V:2 name="左手" clef=bass
C,4 | F,4 | G,4 | C,4 |
`,
          bpm: 60,
          pass: 0.8,
          passHint: "判定看右手。左手每小节第一拍和右手的第一个音要同时落下。",
          keys: [48, 69],
          focus: "先把左手的四个根音记熟，再合右手",
        },
        takeaway: "合手的顺序永远是：左手单独 → 右手单独 → 慢速合 → 只对每小节第一拍。",
      },
      {
        id: "c5-2",
        title: "左手一拍两个音",
        goal: "右手四分音符、左手二分音符，两种节奏互不干扰。",
        minutes: 20,
        brief: [
          {
            h: "左手变成走动的低音",
            body: "左手不再一小节一个音，而是两个（根音 + 五音）。右手照旧一拍一个音。这是真正的「两种节奏同时进行」。",
          },
          {
            h: "不要用一只手去带另一只手",
            body: "很多人会让左手跟着右手的节奏走，结果左手也变成一拍一个。要在心里同时数两条线：右手数 1-2-3-4，左手数 1-（空）-3-（空）。",
            tip: "如果实在合不上，先用嘴把左手唱出来（咚—空—咚—空），手上只弹右手。嘴能分开，手就能分开。",
          },
        ],
        practice: {
          abc: `X:1
T:右手一拍一个，左手两拍一个
M:4/4
L:1/4
Q:1/4=60
%%score {1 2}
K:C
V:1 name="右手" clef=treble
C C G G | A A G2 | F F E E | D D C2 |
V:2 name="左手" clef=bass
C,2 G,2 | F,2 C,2 | G,2 D,2 | C,2 C,2 |
`,
          bpm: 60,
          pass: 0.8,
          passHint: "右手四小节连弹；左手在第 1、3 拍各一个音。",
          keys: [48, 69],
          focus: "左手只数 1 和 3，右手数 1-2-3-4",
        },
        takeaway: "两种节奏并行靠「心里两条线」，不靠一只手带另一只手。",
      },
      {
        id: "c5-3",
        title: "左手八分音符分解和弦",
        goal: "左手持续八分音符伴奏，右手旋律不被带快。",
        minutes: 22,
        brief: [
          {
            h: "琶音式伴奏",
            body: "左手按「根音-三音-五音-三音」的顺序上下跑，一小节八个八分音符。这是流行钢琴最典型的伴奏织体，听起来连绵不断。",
          },
          {
            h: "右手的难关：不被左手带跑",
            body: "左手一直在动，右手很容易跟着加速。这时要靠节拍器，或者把左手音量调到很小，让耳朵主要听右手。",
            tip: "左手八分音符要「重量均匀」，不要第一个音重后面轻。用手指小幅度的动作，不要抬手腕。",
          },
        ],
        practice: {
          abc: `X:1
T:左手八分分解 + 右手长音
M:4/4
L:1/4
Q:1/4=60
%%score {1 2}
K:C
V:1 name="右手" clef=treble
[CEG]4 | [CFA]4 | [GBd]4 | [CEG]4 |
V:2 name="左手" clef=bass
C,/2 E,/2 G,/2 E,/2 C,/2 E,/2 G,/2 E,/2 | F,/2 A,/2 C/2 A,/2 F,/2 A,/2 C/2 A,/2 | G,/2 B,/2 D/2 B,/2 G,/2 B,/2 D/2 B,/2 | C,/2 E,/2 G,/2 E,/2 C,/2 E,/2 G,/2 E,/2 |
`,
          bpm: 60,
          pass: 0.8,
          passHint: "判定看右手（每小节一个和弦）。左手八分音符要匀，不要越弹越快。",
          keys: [48, 74],
          focus: "左手八分音符匀速，右手每小节一个和弦",
        },
        takeaway: "八分分解是流行钢琴的基本织体；匀速比速度重要。",
      },
      {
        id: "c5-4",
        title: "《小星星》双手完整版",
        goal: "双手完整弹完 8 小节，是这一章的毕业曲。",
        minutes: 25,
        brief: [
          {
            h: "把前面四课拼起来",
            body: "右手用第 3 章练熟的旋律，左手用第 5 章第 2 课的「根音 + 五音」。两件事你都单独会了，现在只是让它们同时发生。",
          },
          {
            h: "速度先砍一半",
            body: "单手的熟练速度是 80，合手就从 60 开始，甚至 50。等你能在 60 连续弹三遍不错，再往上加。第一天就想弹回 80，只会练出一堆坏习惯。",
            tip: "错了不要停下来重来。停下来会让你习惯「一错就断」，真正演奏时不能断。先按错的弹下去，下一遍再改。",
          },
        ],
        practice: {
          abc: `X:1
T:小星星（双手完整）
M:4/4
L:1/4
Q:1/4=66
%%score {1 2}
K:C
V:1 name="右手" clef=treble
C C G G | A A G2 | F F E E | D D C2 |
G G F F | E E D2 | G G F F | E E D2 |
V:2 name="左手" clef=bass
C,2 G,2 | F,2 C,2 | G,2 D,2 | C,2 C,2 |
C,2 G,2 | F,2 C,2 | G,2 D,2 | C,2 C,2 |
`,
          bpm: 66,
          pass: 0.8,
          passHint: "判定看右手。8 小节双手一起走完，中途不许停。",
          keys: [48, 69],
          focus: "慢速优先：先 50，稳了三遍再往上加",
        },
        takeaway: "双手合 = 两个已经练熟的东西同时发生；速度永远最后加。",
      },
    ],
  },
  {
    id: "c6",
    title: "第 6 章 · 简谱与首调",
    subtitle: "为什么同一首歌，简谱写 1 2 3，换个人唱却从别的音开始？这一章讲清「首调」。",
    lessons: [
      {
        id: "c6-1",
        title: "简谱的 1 2 3 4 5 6 7",
        goal: "用简谱读出音阶，并知道八度点和减时线的意思。",
        minutes: 12,
        brief: [
          {
            h: "数字本身就是唱名",
            body: "简谱用 1 到 7 表示 do re mi fa sol la si。它不写绝对音高，只写「在调里排第几级」—— 这是它和五线谱最大的不同。",
          },
          {
            h: "八度点与时值",
            body: "数字上面加一点是高八度，下面加一点是低八度。数字下面的短横线是减时线：一条减一半（八分音符），两条再减一半（十六分音符）。数字后面跟横线「-」是延长一拍。",
            tip: "简谱在中文环境里极常见（教材、歌本、合唱谱）。学会看它，等于多了一把钥匙 —— 本应用的「简谱」视图就是按首调排的。",
          },
        ],
        practice: {
          abc: `X:1
T:C 大调音阶上下行
M:4/4
L:1/4
Q:1/4=72
K:C
C D E F | G A B c | c B A G | F E D C |
`,
          bpm: 72,
          pass: 0.85,
          passHint: "上下行各两小节。切到「简谱」视图对照着看，1 就是 C。",
          keys: [60, 72],
          focus: "念 1 2 3 4 5 6 7 1，手上弹 C D E F G A B C",
        },
        takeaway: "简谱数字 = 调内级数；上点高八度、下点低八度、下划线减时值。",
      },
      {
        id: "c6-2",
        title: "1 = G：换一个调，谱子不用改",
        goal: "理解首调：同一段简谱，1=G 时整体换个高度弹。",
        minutes: 15,
        brief: [
          {
            h: "1 是可以移动的",
            body: "1=C 时 1 是 C；1=G 时 1 就是 G。谱子上的数字一个都不用改，你只要把「1」挪到 G 上，其余按相对关系跟着挪。这就是首调唱名法。",
          },
          {
            h: "G 大调要多一个升号",
            body: "G 大调的音阶是 G A B C D E F# G。第 7 级是 F#，不是 F。五线谱会在开头画一个升号提醒你；简谱则在 1=G 之外，遇到 7 会写一个升号标记。",
            tip: "最容易错的是第 7 级。弹 G 大调时手指要记住「F 键右边的黑键」，不要顺手按白键 F。",
          },
        ],
        practice: {
          abc: `X:1
T:G 大调音阶
M:4/4
L:1/4
Q:1/4=66
K:G
G A B c | d e f g |
`,
          bpm: 66,
          pass: 0.85,
          passHint: "G 大调音阶上行。最后一个音 f 是 F#（黑键），别按白键。",
          keys: [66, 79],
          focus: "1=G：从 G 起，第 7 级是 F#（黑键）",
        },
        takeaway: "首调里 1 是移动的；1=G 时第 7 级变成 F#，这是唯一要改的键。",
      },
      {
        id: "c6-3",
        title: "用简谱弹《欢乐颂》",
        goal: "不看五线谱，只用简谱数字把《欢乐颂》主题弹出来。",
        minutes: 20,
        brief: [
          {
            h: "贝多芬的最简单一句",
            body: "《欢乐颂》主题的音是 3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3 2 2。全是相邻的音级，没有一个跳进 —— 这就是它能被所有人记住的原因。",
          },
          {
            h: "节奏的形状：短-短-短-长",
            body: "每句三个四分音符加一个二分音符，最后落在 2 上停两拍。这个「三短一长」的形状贯穿全曲，弹的时候要把它弹出来，否则会变成流水账。",
            tip: "第 4 小节末尾的 2 要停满两拍再进下一句。很多人这里赶，整首就显得慌。",
          },
        ],
        practice: {
          abc: `X:1
T:欢乐颂（主题）
M:4/4
L:1/4
Q:1/4=72
K:C
E E F G | G F E D | C C D E | E D D2 |
`,
          bpm: 72,
          pass: 0.85,
          passHint: "右手 4 小节。切到简谱视图对照：3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3 2 2。",
          keys: [60, 67],
          focus: "念 3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3 2 2-",
        },
        takeaway: "简谱让你只看音级关系就能弹；《欢乐颂》主题在 C 大调是 3 3 4 5 5 4 3 2。",
      },
    ],
  },
  {
    id: "c7",
    title: "第 7 章 · 弹出表情",
    subtitle: "音符对了只是及格。这一章讲力度、连断与收尾 —— 让同一段谱子听起来像有人说话。",
    lessons: [
      {
        id: "c7-1",
        title: "力度：p / mf / f",
        goal: "用三种不同的力度弹同一句，并听出区别。",
        minutes: 12,
        brief: [
          {
            h: "谱子上的字母",
            body: "p（piano）是轻，mf（mezzo-forte）是中强，f（forte）是强。还有 pp（很轻）和 ff（很强）。它们不是「小声/大声」的开关，而是一条连续的线。",
          },
          {
            h: "力度靠重量，不靠僵硬",
            body: "要弹响，用整个手臂自然落下的重量通过手指传进琴键，不是让手指绷紧去砸。要弹轻，也不是不敢按，而是控制落下的重量更少 —— 键必须到底，只是速度慢。",
            tip: "轻不等于虚。p 也要把键按到底，声音才结实；浮在键上的「轻」听上去是虚的。",
          },
        ],
        practice: {
          abc: `X:1
T:同一句的三种力度
M:4/4
L:1/4
Q:1/4=66
K:C
C D E F | G F E D |
`,
          bpm: 66,
          pass: 0.9,
          passHint: "同样两小节弹三遍：第一遍很轻（p），第二遍中等（mf），第三遍强（f）。",
          keys: [60, 67],
          focus: "三遍的强弱差别要明显到旁人一听就知道",
        },
        takeaway: "力度是连续的层次；轻也要把键按到底，否则是虚不是轻。",
      },
      {
        id: "c7-2",
        title: "连奏与断奏",
        goal: "同一段音，弹成连贯的一条线和一颗颗珠子，两种都对。",
        minutes: 12,
        brief: [
          {
            h: "谱上的小圆点",
            body: "音符头上方有一个小圆点，就是断奏（staccato）：每个音短促、分开，音与音之间留空隙。没有点的地方默认连贯（legato）。",
          },
          {
            h: "两种触键的区别",
            body: "连奏是「后音落下前音才松」，两音之间没有缝；断奏是「按下就松」，靠手腕轻轻弹起，像拍皮球。改的不是速度，是手离开键的时间。",
            tip: "断奏不要用整条手臂去戳，声音会砸。用手腕的弹性，动作很小。",
          },
        ],
        practice: {
          abc: `X:1
T:断奏练习
M:4/4
L:1/4
Q:1/4=72
K:C
C. D. E. F. | G4 |
`,
          bpm: 72,
          pass: 0.9,
          passHint: "前四个音断奏（短、分开），最后一个 G 保持四拍。",
          keys: [60, 67],
          focus: "前四个音要能听出空隙，最后一个音要满",
        },
        takeaway: "连奏与断奏的区别在手离开琴键的时机，不在快慢。",
      },
      {
        id: "c7-3",
        title: "渐强与收尾",
        goal: "给一句旋律做出「越来越强、然后轻轻收住」的形状。",
        minutes: 15,
        brief: [
          {
            h: "一句话的形状",
            body: "好的乐句像说话：起头稍轻，中间最饱满，结尾轻轻放下。谱上会写 cresc.（渐强）和 dim.（渐弱），但即使没写，演奏者也该自己做出这个弧线。",
          },
          {
            h: "收尾别硬刹车",
            body: "最后一个音不要「突然停住」，要让它自然衰减。钢琴的声音一按下就开始消失，所以收尾音要按得更实一点，让它有余音。",
            tip: "整首曲子的最后一个小节最容易弹得太响太急。刻意放慢一点点、放轻一点点，收尾会立刻显得完整。",
          },
        ],
        practice: {
          abc: `X:1
T:渐强与收尾
M:4/4
L:1/4
Q:1/4=66
K:C
E E F G | G2 E2 | C4 |
`,
          bpm: 66,
          pass: 0.9,
          passHint: "前两小节逐渐加强，最后一小节的 C 放轻、放满四拍。",
          keys: [60, 67],
          focus: "先渐强，最后一个 C 轻下来收住",
        },
        takeaway: "乐句有弧线：起头轻、中间满、结尾自然放掉。",
      },
    ],
  },
  {
    id: "c8",
    title: "第 8 章 · 你的第一首独奏",
    subtitle: "把前七章合起来，弹完一首双手完整曲，然后把它录下来、导出去、给别人听。",
    lessons: [
      {
        id: "c8-1",
        title: "《欢乐颂》双手完整版",
        goal: "双手完整弹完 8 小节，能给别人听完不尴尬。",
        minutes: 30,
        brief: [
          {
            h: "这首歌配左手很自然",
            body: "左手一小节一个根音就够了：C、G、C、G、C、G、C、C。不需要花哨，低音只要稳，右手的旋律自然就立起来了。",
          },
          {
            h: "练法：分三段，不要一遍一遍从头来",
            body: "第 1-2 小节一段、第 3-4 小节一段、第 5-8 小节一段。每段单独练到连弹三遍不错，再拼起来。从头重复是最低效的练法 —— 你每次都在重复已经会的地方。",
            tip: "拼起来时速度降到 50。等 50 能完整走两遍，再每次加 5，别一次加 20。",
          },
        ],
        practice: {
          abc: `X:1
T:欢乐颂（双手）
M:4/4
L:1/4
Q:1/4=66
%%score {1 2}
K:C
V:1 name="右手" clef=treble
E E F G | G F E D | C C D E | E D D2 |
E E F G | G F E D | C C D E | D C C2 |
V:2 name="左手" clef=bass
C,4 | G,4 | C,4 | G,4 |
C,4 | G,4 | C,4 | C,4 |
`,
          bpm: 66,
          pass: 0.8,
          passHint: "判定看右手。8 小节双手完整走完，中途不停。",
          keys: [48, 67],
          focus: "分三段练熟再拼；拼的时候 50 起步",
        },
        takeaway: "分段练、慢速拼，是从「会弹」到「能弹给人听」的唯一路径。",
      },
      {
        id: "c8-2",
        title: "录下来、导出去、给人听",
        goal: "把自己弹的曲子存成 WAV / MIDI / MusicXML，并知道每种格式给谁用。",
        minutes: 12,
        brief: [
          {
            h: "三种格式，三种用途",
            body: "WAV 是音频，任何人双击就能听，适合发给家人朋友；MIDI 是音符指令，能在任何音乐软件里改音色和速度，适合给做音乐的人；MusicXML 是乐谱，MuseScore、Sibelius、Dorico 都能打开，适合给会看谱的人。",
          },
          {
            h: "在本应用里怎么做",
            body: "顶栏「导出」里选 WAV，会把当前工程离线渲染成音频（比实时录音稳，不会因为电脑卡顿而断）。选 MusicXML 或 MIDI 则导出可再编辑的谱。",
            tip: "导出的 WAV 是合成音色，不是真钢琴录音。它适合分享和存档；如果要出版级的音色，用 MIDI 导进 Logic 或 Cubase 换音源。",
          },
          {
            h: "然后呢",
            body: "到这里你已经能从零读懂谱、双手弹一首完整的曲子。接下来最有效的三件事：每天 15 分钟音阶、每周一首新曲、把弹的东西录下来回听 —— 回听能听出你自己弹的时候完全没注意到的错误。",
          },
        ],
        takeaway: "WAV 给人听、MIDI 给制作人、MusicXML 给看谱的人；录音回听是最快的进步方法。",
      },
    ],
  },
];

/* ================================================================ 查询 */

export function allLessons(): Lesson[] {
  return CHAPTERS.flatMap((c) => c.lessons);
}

export function totalLessons(): number {
  return allLessons().length;
}

export function findLesson(id: string): Lesson | undefined {
  return allLessons().find((l) => l.id === id);
}

export function chapterOf(lessonId: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.lessons.some((l) => l.id === lessonId));
}

/** 下一课；已经是最后一课时返回 null */
export function nextLesson(id: string): Lesson | null {
  const list = allLessons();
  const i = list.findIndex((l) => l.id === id);
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
}

export function prevLesson(id: string): Lesson | null {
  const list = allLessons();
  const i = list.findIndex((l) => l.id === id);
  return i > 0 ? list[i - 1] : null;
}

/* ================================================================ 练习曲 */

/** ABC → Score 的缓存：课程谱子是常量，没必要每次重解析 */
const scoreCache = new Map<string, Score>();

/**
 * 把一课的练习曲变成可用的 Score。
 *
 * 全部轨强制成钢琴：课程教的是钢琴，解析器默认给第二轨「弦乐」只是为了导入时的兜底。
 * 解析失败返回 null 而不是抛错——课程界面不能因为一段谱子写坏就白屏，
 * 但 verify 会把它报成红（见 scripts/verify.ts），所以坏谱子进不了发布。
 */
export function lessonScore(lesson: Lesson): Score | null {
  const cached = scoreCache.get(lesson.id);
  if (cached) return cached;
  const abc = lesson.practice?.abc;
  if (!abc) return null;
  try {
    const { score } = parseAbc(abc, lesson.title);
    const tuned: Score = {
      ...score,
      subtitle: lesson.goal,
      composer: "MuseLab 课程",
      tracks: score.tracks.map((t, i) => ({
        ...t,
        instrument: "piano",
        name: i === 0 ? "右手" : i === 1 ? "左手" : t.name,
        // 左手压低一档：课程里讲「左手要轻」，谱子自己就该是示范
        volume: i === 0 ? 0.85 : 0.6,
        pan: 0,
      })),
      meta: { origin: "manual", brief: `课程练习：${lesson.title}`, created: "2026-10-28" },
    };
    scoreCache.set(lesson.id, tuned);
    return tuned;
  } catch (e) {
    console.error(`课程 ${lesson.id} 的练习曲解析失败`, e);
    return null;
  }
}

/** 课程谱子的基本信息，界面用来显示「几小节 / 什么调 / 拍号」 */
export function lessonFacts(lesson: Lesson): { bars: number; beats: number; tracks: number } | null {
  const s = lessonScore(lesson);
  if (!s) return null;
  return { bars: measureCount(s), beats: beatsPerMeasure(s), tracks: s.tracks.length };
}

/* ================================================================ 进度 */

export interface LessonRecord {
  done: boolean;
  /** 最好成绩（准确率 0-1） */
  best: number;
  /** 练过几次 */
  tries: number;
  /** 最后一次练习时间（ISO） */
  at: string;
}

export interface Progress {
  v: 1;
  lessons: Record<string, LessonRecord>;
}

export const PROGRESS_KEY = "z-biz-tool-music-progress";

/** 只依赖传进来的 storage，方便测试里塞假 storage */
export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ProgressStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function emptyProgress(): Progress {
  return { v: 1, lessons: {} };
}

export function loadProgress(store: ProgressStorage | null = browserStorage()): Progress {
  if (!store) return emptyProgress();
  try {
    const raw = store.getItem(PROGRESS_KEY);
    if (!raw) return emptyProgress();
    const o = JSON.parse(raw) as Partial<Progress>;
    if (!o || typeof o !== "object" || !o.lessons || typeof o.lessons !== "object") return emptyProgress();
    const cleaned: Record<string, LessonRecord> = {};
    for (const [k, v] of Object.entries(o.lessons)) {
      if (!v || typeof v !== "object") continue;
      const r = v as Partial<LessonRecord>;
      cleaned[k] = {
        done: r.done === true,
        best: typeof r.best === "number" && r.best >= 0 && r.best <= 1 ? r.best : 0,
        tries: typeof r.tries === "number" && r.tries > 0 ? Math.floor(r.tries) : 0,
        at: typeof r.at === "string" ? r.at : "",
      };
    }
    return { v: 1, lessons: cleaned };
  } catch {
    // 进度坏了就当没有：宁可让用户重练一课，也不要让课程界面打不开
    return emptyProgress();
  }
}

export function saveProgress(p: Progress, store: ProgressStorage | null = browserStorage()): void {
  if (!store) return;
  try {
    store.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* 存不下不影响练习本身 */
  }
}

/**
 * 记一次练习结果。纯函数：返回新进度 + 是否刚刚通关，调用方决定存不存。
 *
 * 「通关」只升不降：已经通过的课再练砸了，不该变回未通过 ——
 * 那会让人不敢重复练。
 */
export function recordAttempt(
  progress: Progress,
  lessonId: string,
  accuracy: number,
  passLine: number,
  now: string = new Date().toISOString(),
): { progress: Progress; passed: boolean; firstTime: boolean } {
  const acc = Math.max(0, Math.min(1, accuracy));
  const prev = progress.lessons[lessonId];
  const passed = acc >= passLine;
  const wasDone = prev?.done === true;
  const record: LessonRecord = {
    done: wasDone || passed,
    best: Math.max(prev?.best ?? 0, acc),
    tries: (prev?.tries ?? 0) + 1,
    at: now,
  };
  return {
    progress: { v: 1, lessons: { ...progress.lessons, [lessonId]: record } },
    passed,
    firstTime: passed && !wasDone,
  };
}

export function doneCount(progress: Progress): number {
  return allLessons().filter((l) => progress.lessons[l.id]?.done === true).length;
}

export function totalTries(progress: Progress): number {
  return Object.values(progress.lessons).reduce((a, r) => a + r.tries, 0);
}
