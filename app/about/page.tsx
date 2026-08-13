import Link from "next/link";
import {
  ArrowLeft,
  ArrowSquareOut,
  BookOpenText,
  CaretDown,
  Database,
  Gavel,
  Handshake,
  PencilSimpleLine,
  ShieldWarning,
} from "@phosphor-icons/react/dist/ssr";
import { BearLogo } from "@/components/BearLogo";

const statements = [
  {
    title: "数据来源与权利归属",
    icon: Database,
    content:
      "摊位、社团、作品、图片及活动信息主要整理自 CPP 无差别同人站公开页面，仅用于帮助用户规划和整理个人list。相关内容的著作权、商标权及其他合法权益仍归原作者、社团、上传者或平台权利人所有。",
  },
  {
    title: "允许用途与使用限制",
    icon: Gavel,
    content:
      "使用者不得借助本工具批量复制、镜像发布、出售第三方数据，不得绕过平台访问限制，也不得将相关信息用于侵权、骚扰、欺诈或其他违法活动。",
  },
  {
    title: "非官方说明",
    icon: Handshake,
    content:
      "本项目为独立开发的非官方工具，与 CPP 无差别同人站、COMICUP 及参展社团不存在隶属、授权、代理或合作关系；页面出现第三方名称或标识仅用于说明信息来源。",
  },
  {
    title: "准确性与风险提示",
    icon: ShieldWarning,
    content:
      "数据可能因同步延迟、原页面变更、录入遗漏或自动匹配而出现偏差。购入价格、摊位安排、库存及活动规则应以权利人发布的信息和展会现场为准。用户应自行判断并承担使用结果；在法律允许范围内，开发者不对因信息偏差或服务中断造成的间接损失承担责任。",
  },
  {
    title: "更正、隐藏与删除",
    icon: PencilSimpleLine,
    content:
      "如你是相关权利人，或发现信息错误、遗漏及不宜展示的内容，可通过产品反馈入口联系开发者。核实后将尽快进行更正、隐藏或删除处理。",
  },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 px-4 py-4 sm:gap-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <BearLogo className="h-9 w-9 sm:h-10 sm:w-10" />
            <div className="min-w-0">
              <h1 className="text-sm font-bold leading-5 sm:text-xl">开发者信息与数据版权声明</h1>
              <p className="text-xs text-slate-500 sm:text-sm">CP list帮手</p>
            </div>
          </div>
          <Link href="/" className="ui-btn-outline shrink-0 px-3">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">返回首页</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-4 py-8 sm:px-6 sm:py-10">
        <section className="ui-surface p-5 sm:p-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            Developer
          </p>
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-xl font-bold">IcebearHuang</h2>
              <p className="mt-1 text-sm text-slate-500">
                独立开发与维护这款同人展会list工具。
              </p>
            </div>
            <a
              href="https://xhslink.com/m/j0ghQF9UjL"
              target="_blank"
              rel="noreferrer"
              className="ui-btn-primary"
            >
              小红书主页
              <ArrowSquareOut className="h-4 w-4" />
            </a>
          </div>

          <details className="group mt-5 border-t border-slate-200 pt-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-100 text-slate-700">
                  <BookOpenText className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-base font-semibold">开发者小日记</span>
                  <span className="block text-xs text-slate-500">点击展开彩蛋</span>
                </span>
              </span>
              <CaretDown className="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
            </summary>

            <article className="mt-3 space-y-5 rounded-2xl bg-rose-50/60 px-4 py-5 text-sm leading-7 text-slate-700 sm:px-6 sm:py-6 sm:text-base sm:leading-8">
              <p>
                开发的时候翻到了自己近10年去cp的list，最早可以追溯到2017年，一开始是excel，在本科学校四楼的图书馆里新建一张表，手动把想要的东西录进去，去cp之前打印出来，还要带上一根笔，没准开展前一天还要新增，后来是电子表格，豪气万丈地告诉朋友，你需要我帮你代购的，都填在这个表就可以，和亲友交换表格，然后每年在cp过购物节狂买上几千块。
                <br />
                我是一个超级p人，恨按部就班，只有做这个，确实是开心的。
              </p>

              <div className="space-y-2">
                <p className="font-semibold text-slate-900">这是一个关于「期待」的故事。</p>
                <p>
                  幸福不只产生于幸福的事发生的那一刻，期待幸福，本身就是一种幸福。
                  <br />
                  周五下班的时候看周六要去哪里吃饭，旅行前搜目的地有什么好吃的，cp前搜索要买什么本子，在漫长而痛苦的生活里，需要靠着这一点点甜来支撑自己。
                </p>
              </div>

              <div className="space-y-2">
                <p>
                  因为太讨厌我的工作，我像狗一样乞求我的生活中能有一星半点的正反馈，于是我开始做了这个项目。
                </p>
                <p>
                  首先应该来源于自己。正如搞同人，万千理由，不过是自己喜欢。
                  <br />
                  其次应该简单。每一个功能都应该着力于解决已有的问题。
                  <br />
                  最后应该完整。在脑海里放映了我每次去展会的流程，点心愿单，梳理信息，分享，采购，环环相扣，于是有了这样一个工具。
                </p>
              </div>

              <div className="space-y-2">
                <p className="font-semibold text-slate-900">工具是为了帮助人，而不是代替人。</p>
                <p>
                  我希望能帮人免去统计和四处收集的重复性事务，帮人快速统计和记录信息，最大程度地减少过程中蹉跎的沙砾感——which i think，作为一个简中同人女，大家都背负了太多。但喜欢什么、想买什么、怎么去玩，这些让人幸福的、让人期待的，还是需要每一个人亲自来做、来体会。
                </p>
              </div>

              <footer className="pt-1 text-left">
                <p className="font-bold text-slate-900">衷心地希望你能在cp玩得开心&gt;&lt;</p>
                <p className="mt-2 text-right text-slate-600">同人女 黄白熊</p>
              </footer>
            </article>
          </details>
        </section>

        <div className="ui-surface divide-y divide-slate-200 px-5 sm:px-6">
          {statements.map(({ title, icon: Icon, content }) => (
            <section key={title} className="py-5 sm:py-6">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-100 text-slate-700">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="mb-2 text-base font-semibold sm:text-lg">{title}</h2>
                  <p className="text-sm leading-7 text-slate-600 sm:text-base">{content}</p>
                </div>
              </div>
            </section>
          ))}
        </div>

        <p className="px-1 text-center text-xs leading-6 text-slate-500">
          如需反馈、更正或删除相关信息，可通过开发者小红书主页联系。
        </p>
      </main>
    </div>
  );
}
