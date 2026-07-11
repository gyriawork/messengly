import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Tags · Messengly' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
