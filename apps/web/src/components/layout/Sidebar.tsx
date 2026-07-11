'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Send,
  FileText,
  Activity,
  Settings,
  LogOut,
  Inbox,
  Tag,
  ShieldCheck,
  Shield,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { OrgSwitcher } from './OrgSwitcher';

// Messenger, Wiki and Analytics intentionally hidden — service is focused on
// importing chats and broadcasting prepared messages to Slack/Telegram.
const baseNavItems = [
  { icon: LayoutDashboard, href: '/', label: 'Dashboard' },
  { icon: Inbox, href: '/chats', label: 'Chats' },
  { icon: Activity, href: '/activity', label: 'Activity Log' },
];

// Broadcasting tools — visible to every authenticated user, since broadcasting
// is the regular user's primary (and only) job. Messenger configuration lives
// under superadmin-only sections.
const broadcastNavItems = [
  { icon: Send, href: '/broadcast', label: 'Broadcast' },
  { icon: FileText, href: '/templates', label: 'Templates' },
  { icon: Tag, href: '/tags', label: 'Tags' },
];

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?';

  return (
    <aside
      style={{ fontFamily: "'Inter', 'Figtree', system-ui, sans-serif" }}
      className={cn(
        'hidden h-[100dvh] flex-col bg-gradient-to-b from-[#1e1b4b] to-[#312e81] py-4 transition-all duration-200 md:flex',
        collapsed ? 'w-16 items-center px-2' : 'w-[272px] px-4',
      )}
    >
      {/* Logo + Collapse toggle */}
      <div className={cn('mb-6 flex items-center', collapsed ? 'justify-center' : 'justify-between px-2')}>
        <div className="flex items-center gap-2.5">
          {collapsed ? (
            <img src="/logo-icon.svg" alt="m" className="h-7" />
          ) : (
            <img src="/logo.svg" alt="messengly" className="h-7" />
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="rounded-md p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-white/70"
            title="Collapse sidebar"
          >
            <ChevronsLeft className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/5 hover:text-white/70"
          title="Expand sidebar"
        >
          <ChevronsRight className="h-5 w-5" />
        </button>
      )}

      {/* Organization switcher (superadmin only) */}
      {user?.role === 'superadmin' && <OrgSwitcher collapsed={collapsed} />}

      {/* Navigation */}
      {(() => {
        const navItems = [
          ...baseNavItems,
          // Broadcast / Templates / Tags are the regular user's main tools.
          ...broadcastNavItems,
          ...(user?.role === 'superadmin'
            ? [
                { icon: ShieldCheck, href: '/admin', label: 'Admin' },
                { icon: Shield, href: '/admin/platform', label: 'Platform' },
              ]
            : []),
          { icon: Settings, href: '/settings', label: 'Settings' },
        ];
        // Sliding active indicator: items are uniform (item height + gap-0.5),
        // so the bar just translates to activeIndex × stride.
        const activeIndex = navItems.findIndex(({ href }) => isActive(href));
        const stride = collapsed ? 50 : 54;
        const itemH = collapsed ? 48 : 52;
        return (
      <nav className={cn('relative flex flex-1 flex-col gap-0.5', collapsed && 'items-center')}>
        {activeIndex >= 0 && (
          <span
            aria-hidden
            className="absolute left-0 w-1 rounded-full bg-white/90 motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out"
            style={{
              height: 32,
              top: (itemH - 32) / 2,
              transform: `translateY(${activeIndex * stride}px)`,
            }}
          />
        )}
        {navItems.map(({ icon: Icon, href, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                'group relative flex items-center rounded-lg transition-all',
                collapsed
                  ? 'h-12 w-12 justify-center'
                  : 'gap-4 px-4 py-3 text-xl font-bold uppercase tracking-wide',
                active
                  ? 'bg-white/15 text-white ring-4 ring-inset ring-white/20'
                  : 'text-white/50 hover:bg-white/5 hover:text-white/80',
              )}
            >
              <Icon className="h-7 w-7 shrink-0" strokeWidth={active ? 2 : 1.5} />
              {!collapsed && label}
              {collapsed && (
                <span className="pointer-events-none absolute left-full z-50 ml-3 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  {label}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
        );
      })()}

      {/* Bottom: User info + Logout */}
      <div
        className={cn(
          'flex items-center border-t border-white/10 pt-3',
          collapsed ? 'flex-col gap-2' : 'gap-2',
        )}
      >
        <div
          title={collapsed ? (user?.name || 'User') : undefined}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-avatar bg-white/15 text-sm font-medium text-white"
        >
          {initials}
        </div>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-white/60">
              {user?.name || user?.email || 'User'}
            </span>
            <button
              onClick={logout}
              title="Sign out"
              className="shrink-0 rounded-md p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-white/60"
            >
              <LogOut className="h-5 w-5" strokeWidth={1.5} />
            </button>
          </>
        )}
        {collapsed && (
          <button
            onClick={logout}
            title="Sign out"
            className="group relative flex h-8 w-8 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/5 hover:text-white/60"
          >
            <LogOut className="h-5 w-5" strokeWidth={1.5} />
            <span className="pointer-events-none absolute left-full z-50 ml-3 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              Sign out
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}
