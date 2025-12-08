import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DCM Surgical Recommender | Ascension Seton",
  description:
    "Prototype decision-support site for degenerative cervical myelopathy (DCM) at Ascension Seton.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
