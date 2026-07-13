'use client';

import { useRef, useState } from 'react';
import { Loader2, Upload, Trash2, Building2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { humanizeError } from '@/lib/errors';
import { resizeImageToSquareDataUrl } from '@/lib/image';
import { useAuthStore } from '@/stores/auth';
import { useSuperadminStore } from '@/stores/superadmin';

// Matches the fixed square the logo is drawn into (lib/image.ts) and the
// sidebar avatar, so what you upload is exactly what you see.
const LOGO_SIZE = 128;
const ACCEPTED = 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif';

function initialsOf(name?: string | null): string {
  if (!name) return '?';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function OrganizationTab() {
  const user = useAuthStore((s) => s.user);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const isSuperadmin = user?.role === 'superadmin';
  const selectedOrgId = useSuperadminStore((s) => s.selectedOrgId);
  const selectedOrgName = useSuperadminStore((s) => s.selectedOrgName);
  const selectedOrgLogo = useSuperadminStore((s) => s.selectedOrgLogo);

  // The org being edited: the selected one for a superadmin, otherwise the
  // admin's own org.
  const orgName = isSuperadmin ? selectedOrgName : user?.organization?.name ?? null;
  const storedLogo = isSuperadmin ? selectedOrgLogo : user?.organization?.logo ?? null;
  const hasOrgContext = isSuperadmin ? Boolean(selectedOrgId) : Boolean(user?.organizationId);

  // Local preview so the change shows immediately after saving.
  const [logo, setLogo] = useState<string | null>(storedLogo);

  const mutation = useMutation({
    mutationFn: (nextLogo: string | null) =>
      api.patch<{ organization: { id: string; name: string; logo: string | null } }>(
        '/api/organizations/current',
        { logo: nextLogo },
      ),
    onSuccess: (res) => {
      const org = res.organization;
      setLogo(org.logo);
      // Reflect the change wherever the sidebar reads its org branding from.
      if (isSuperadmin) {
        useSuperadminStore.getState().setOrg(org.id, org.name, org.logo);
      } else {
        fetchMe();
      }
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success(org.logo ? 'Logo updated' : 'Logo removed');
    },
    onError: (err) => toast.error(humanizeError(err, 'Could not save the logo')),
  });

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image is too large (max 5MB)');
      return;
    }
    try {
      const dataUrl = await resizeImageToSquareDataUrl(file, LOGO_SIZE);
      mutation.mutate(dataUrl);
    } catch (err) {
      toast.error(humanizeError(err, 'That image could not be processed'));
    }
  };

  const displayLogo = logo;
  const orgInitials = initialsOf(orgName);
  const userInitials = initialsOf(user?.name);

  return (
    <div className="space-y-6">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-slate-900">Organization</h2>
        <p className="text-sm text-slate-500">
          Set your company logo. It appears in the sidebar in place of the initials.
        </p>
      </div>

      {!hasOrgContext ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white p-8 text-center">
          <Building2 className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            {isSuperadmin
              ? 'Select an organization in the sidebar first, then set its logo here.'
              : 'No organization is linked to your account yet.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg bg-white p-6 shadow-xs">
          <h3 className="mb-5 text-sm font-semibold text-slate-900">Company logo</h3>

          <div className="flex flex-wrap items-center gap-5">
            {/* Current logo / fallback */}
            <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-avatar bg-slate-100 ring-1 ring-slate-200">
              {displayLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayLogo} alt="Company logo" className="h-full w-full object-contain" />
              ) : (
                <span className="text-2xl font-semibold text-slate-400">{orgInitials}</span>
              )}
            </div>

            <div className="flex flex-1 flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={mutation.isPending}
                  className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:opacity-50"
                >
                  {mutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {displayLogo ? 'Replace logo' : 'Upload logo'}
                </button>
                {displayLogo && (
                  <button
                    type="button"
                    onClick={() => mutation.mutate(null)}
                    disabled={mutation.isPending}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </button>
                )}
              </div>

              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED}
                className="hidden"
                onChange={(e) => {
                  handleFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />

              <div className="text-xs leading-relaxed text-slate-500">
                <p className="font-medium text-slate-600">Recommended</p>
                <p>
                  Square image, at least {LOGO_SIZE}&times;{LOGO_SIZE}px. PNG or SVG with a
                  transparent background looks best. PNG, JPG, WEBP, SVG or GIF, up to 5MB.
                </p>
                <p className="mt-1">
                  We automatically fit it into a {LOGO_SIZE}&times;{LOGO_SIZE} square, so it lines
                  up perfectly in the sidebar.
                </p>
              </div>
            </div>
          </div>

          {/* Live preview of the sidebar footer */}
          <div className="mt-6">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
              Sidebar preview
            </p>
            <div className="w-[240px] max-w-full rounded-2xl bg-gradient-to-b from-[#1e1b4b] to-[#312e81] p-3">
              <div className="flex items-center gap-2 border-t border-white/10 pt-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-avatar bg-white/15 text-sm font-medium text-white">
                  {displayLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={displayLogo} alt="" className="h-full w-full object-contain" />
                  ) : (
                    userInitials
                  )}
                </div>
                <span className="min-w-0 flex-1 truncate text-sm text-white/70">
                  {user?.name || user?.email || 'User'}
                </span>
                <LogOut className="h-4 w-4 shrink-0 text-white/40" strokeWidth={1.5} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
