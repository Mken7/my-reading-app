import type { Metadata } from "next";
import { V2Preview } from "./V2Preview";

export const metadata: Metadata = {
  title: "安全书房 V2 · 测试预览",
  description: "仅测试环境：独立邮箱登录与双人书房权限验收",
};

export default function V2PreviewPage() {
  return (
    <main className="h-full overflow-y-auto bg-[#f3efe6] px-4 py-12 text-[#2c2825]">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 border-b border-[#d9d0c1] pb-6">
          <p className="text-xs tracking-[0.25em] text-[#84796a]">S. / TEST ENVIRONMENT</p>
          <h1 className="mt-3 font-serif text-3xl">双人书房 · 安全预览</h1>
          <p className="mt-3 text-sm leading-7 text-[#6b6560]">
            与旧版书籍和账号完全隔离。这里只能连接单独的 Supabase 测试项目，不提供正式网站服务。
          </p>
        </header>
        <V2Preview />
      </div>
    </main>
  );
}
