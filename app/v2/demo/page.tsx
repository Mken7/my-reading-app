import type { Metadata } from "next";
import Link from "next/link";
import { DemoLibrary } from "./DemoLibrary";
import "./demo.css";

export const metadata: Metadata = {
  title: "共读书房｜无需登录的设计演示",
  description: "无需账号与数据库，在浏览器中体验书架、双人阅读、批注和个性化设置。",
};

export default function DemoPage() {
  return (
    <main className="demo-outer">
      <div className="demo-accessibility-top">
        <Link href="/v2">← 返回 V2 测试入口</Link>
        <span>仅供查看设计 · 不需要登录</span>
      </div>
      <DemoLibrary />
    </main>
  );
}
