import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Chats · Messengly' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
