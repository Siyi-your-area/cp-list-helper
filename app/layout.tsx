import type { Metadata } from "next";
import { Noto_Sans_SC } from "next/font/google";
import { PageViewTracker } from "@/components/PageViewTracker";
import "./globals.css";

const notoSansSC = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-noto-sans-sc",
});

export const metadata: Metadata = {
  title: "CP list帮手",
  description: "同人展会list管理工具",
  creator: "IcebearHuang",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={notoSansSC.variable}>
      <body>
        <PageViewTracker />
        {children}
      </body>
    </html>
  );
}

