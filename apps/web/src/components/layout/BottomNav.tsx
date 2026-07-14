'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useChatStore } from '@/stores/chat';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  LayoutDashboard,
  Inbox,
  Download,
  Send,
  MoreHorizontal,
  FileText,
  Tag,
  Activity,
  Settings,
  ShieldCheck,
  Shield,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';

// Mirrors the desktop sidebar: Messenger and Wiki are intentionally hidden
// there, so they don't belong in the mobile nav either.
const tabs = [
  { icon: LayoutDashboard, href: '/', label: 'Dashboard' },
  { icon: Inbox, href: '/chats', label: 'Chats' },
  { icon: Download, href: '/import', label: 'Import' },
  { icon: Send, href: '/broadcast', label: 'Broadcast' },
];

const moreItems = [
  { icon: Activity, href: '/activity', label: 'Activity' },
  { icon: FileText, href: '/templates', label: 'Templates' },
  { icon: Tag, href: '/tags', label: 'Labels' },
  { icon: Settings, href: '/settings', label: 'Settings' },
];

export function BottomNav() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const [showMore, setShowMore] = useState(false);
  const mobileView = useChatStore((s) => s.mobileView);
  const isMobile = useIsMobile();
  const hideOnMessenger = isMobile && pathname === '/messenger' && mobileView !== 'list';

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const isMoreActive = moreItems.some((item) => isActive(item.href));

  if (hideOnMessenger) return null;

  return (
    <>
      {showMore && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setShowMore(false)}
        />
      )}

      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-white px-4 pb-[calc(56px+env(safe-area-inset-bottom))] pt-4 shadow-lg transition-transform duration-200',
          showMore ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-900">More</span>
          <button
            onClick={() => setShowMore(false)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {moreItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setShowMore(false)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl py-3 text-slate-500 transition-colors',
                isActive(item.href)
                  ? 'bg-accent/10 text-accent'
                  : 'hover:bg-slate-50',
              )}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          ))}
          {user?.role === 'superadmin' && (
            <>
              <Link
                href="/admin"
                onClick={() => setShowMore(false)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-xl py-3 text-slate-500 transition-colors',
                  isActive('/admin') && !isActive('/admin/platform')
                    ? 'bg-accent/10 text-accent'
                    : 'hover:bg-slate-50',
                )}
              >
                <ShieldCheck className="h-5 w-5" />
                <span className="text-[10px] font-medium">Admin</span>
              </Link>
              <Link
                href="/admin/platform"
                onClick={() => setShowMore(false)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-xl py-3 text-slate-500 transition-colors',
                  isActive('/admin/platform')
                    ? 'bg-accent/10 text-accent'
                    : 'hover:bg-slate-50',
                )}
              >
                <Shield className="h-5 w-5" />
                <span className="text-[10px] font-medium">Platform</span>
              </Link>
            </>
          )}
        </div>
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-slate-200 bg-white px-2 safe-bottom md:hidden"
        style={{ height: 56 }}
      >
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 text-slate-400 transition-colors',
              isActive(tab.href) && 'text-accent',
            )}
          >
            <tab.icon className="h-5 w-5" />
            <span className="text-[10px] font-medium">{tab.label}</span>
          </Link>
        ))}
        <button
          onClick={() => setShowMore(!showMore)}
          className={cn(
            'flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 text-slate-400 transition-colors',
            isMoreActive && 'text-accent',
          )}
        >
          <MoreHorizontal className="h-5 w-5" />
          <span className="text-[10px] font-medium">More</span>
        </button>
      </nav>
    </>
  );
}
