import type { Metadata } from "next";
import Link from "next/link";
import { V2Preview } from "./V2Preview";
import "./device-compat.css";

export const metadata: Metadata = {
  title: "安全书房 V2 · 测试预览",
  description: "仅测试环境：独立邮箱登录与双人书房权限验收",
};

export default function V2PreviewPage() {
  return (
    <main className="v2-preview-shell h-full overflow-y-auto bg-[#f3efe6] px-4 py-12 text-[#2c2825]">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 border-b border-[#d9d0c1] pb-6">
          <p className="text-xs tracking-[0.25em] text-[#84796a]">S. / TEST ENVIRONMENT</p>
          <h1 className="mt-3 font-serif text-3xl">双人书房 · 安全预览</h1>
          <p className="mt-3 text-sm leading-7 text-[#6b6560]">
            与旧版书籍和账号完全隔离。这里只能连接单独的 Supabase 测试项目，不提供正式网站服务。
          </p>
        </header>
        <section className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#cdd9c9] bg-[#e5ecdf] px-5 py-5">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.18em] text-[#78907b]">DESIGN WALKTHROUGH</p>
            <h2 className="mt-1 font-serif text-xl text-[#354b3e]">先逛一逛我们的共读书房</h2>
            <p className="mt-2 text-xs leading-6 text-[#697969]">
              无需登录、无需 Supabase。书架、翻页、批注、夜间模式均可体验；不会写入真实数据。
            </p>
          </div>
          <Link href="/v2/demo"
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-3 rounded-full bg-[#3e584d] px-6 py-3 text-sm font-medium text-white hover:bg-[#2e4438] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3e584d]">
            进入免登录 UI 演示 <span aria-hidden="true">↗</span>
          </Link>
        </section>
        <V2Preview />
      </div>
    </main>
  );
}
