'use client';

import { useEffect } from 'react';
import { Building2, ChevronDown, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useSuperadminStore } from '@/stores/superadmin';
import { cn } from '@/lib/utils';

export function OrgSwitcher({ collapsed }: { collapsed: boolean }) {
  const { data: orgs } = useOrganizations();
  const queryClient = useQueryClient();
  const selectedOrgId = useSuperadminStore((s) => s.selectedOrgId);
  const selectedOrgName = useSuperadminStore((s) => s.selectedOrgName);
  const setOrg = useSuperadminStore((s) => s.setOrg);
  const clearOrg = useSuperadminStore((s) => s.clearOrg);

  const organizations = Array.isArray(orgs) ? orgs : [];

  // Clear selection if the selected org was deleted
  useEffect(() => {
    if (selectedOrgId && organizations.length > 0 && !organizations.some((o) => o.id === selectedOrgId)) {
      clearOrg();
      queryClient.resetQueries();
    }
  }, [selectedOrgId, organizations, clearOrg, queryClient]);

  const handleChange = (orgId: string) => {
    if (!orgId) {
      clearOrg();
    } else {
      const org = organizations.find((o) => o.id === orgId);
      if (org) setOrg(org.id, org.name, (org as { logo?: string | null }).logo ?? null);
    }
    queryClient.resetQueries();
  };

  if (collapsed) {
    return (
      <div className="group relative mb-3 flex h-8 w-8 items-center justify-center">
        <div
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
            selectedOrgId
              ? 'bg-accent/20 text-accent'
              : 'text-white/30',
          )}
        >
          <Building2 className="h-4 w-4" />
        </div>
        <span className="pointer-events-none absolute left-full z-50 ml-3 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
          {selectedOrgName || 'No organization selected'}
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 px-1">
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-white/40">
        Organization
      </label>
      <div className="relative">
        <select
          value={selectedOrgId ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          className={cn(
            'w-full appearance-none rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 pr-8 text-sm font-medium text-white outline-none transition-colors',
            'hover:bg-white/10 focus:border-white/20 focus:bg-white/10',
          )}
        >
          <option value="" className="bg-slate-800 text-white">
            Select organization
          </option>
          {organizations.map((org) => (
            <option key={org.id} value={org.id} className="bg-slate-800 text-white">
              {org.name}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
      </div>
      {selectedOrgId && (
        <button
          onClick={() => handleChange('')}
          className="mt-1.5 flex items-center gap-1 text-xs text-white/40 transition-colors hover:text-white/60"
        >
          <X className="h-2.5 w-2.5" />
          Clear selection
        </button>
      )}
    </div>
  );
}
