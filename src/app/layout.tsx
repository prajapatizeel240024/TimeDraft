import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TimeDraft',
  description: "Drafts an attorney's billable day from email, calendar, documents and calls, for review.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">{children}</div>
      </body>
    </html>
  );
}
