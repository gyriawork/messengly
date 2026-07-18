'use client';

import { Shield, Loader2, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { usePlatformConfig } from '@/hooks/usePlatformConfig';
import { PlatformConfigCard } from '@/components/admin/PlatformConfigCard';

export default function PlatformSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const { data: entries, isLoading } = usePlatformConfig();

  if (user?.role !== 'superadmin') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Shield className="mb-3 h-10 w-10 text-slate-300" />
        <h2 className="text-lg font-semibold text-slate-900">Access Denied</h2>
        <p className="mt-1 text-sm text-slate-500">
          Only superadmins can manage platform credentials.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin"
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Platform Settings</h1>
          <p className="text-sm text-slate-500">
            Configure API credentials for each messenger. Users will only see
            messengers that have been configured here.
          </p>
        </div>
      </div>

      {/* Cards */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      ) : (
        <div className="space-y-3">
          {(entries ?? [])
            .filter((entry) => entry.messenger !== 'gmail') // Gmail hidden — broadcast-focused service
            .map((entry, i) => (
              <div key={entry.messenger} className="motion-safe:animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
                <PlatformConfigCard entry={entry} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
