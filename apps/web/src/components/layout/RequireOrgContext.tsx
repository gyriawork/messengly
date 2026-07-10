'use client';

import { Building2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useSuperadminStore } from '@/stores/superadmin';

export function RequireOrgContext({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  const selectedOrgId = useSuperadminStore((s) => s.selectedOrgId);

  if (role === 'superadmin' && !selectedOrgId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-slate-100">
            <Building2 className="h-7 w-7 text-slate-400" />
          </div>
          <h2 className="text-lg font-semibold text-slate-800">
            Select an organization
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Pick an organization in the sidebar to get started
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
