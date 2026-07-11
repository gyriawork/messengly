'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Save, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';

// ---------- Schemas ----------

const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

const passwordSchema = z
  .object({
    oldPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type ProfileFormValues = z.infer<typeof profileSchema>;
type PasswordFormValues = z.infer<typeof passwordSchema>;

// ---------- Component ----------

export function ProfileTab() {
  const user = useAuthStore((s) => s.user);

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?';

  // Profile form
  const profileForm = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: user?.name ?? '' },
  });

  const handleProfileSubmit = async (data: ProfileFormValues) => {
    try {
      await api.patch('/api/users/me', data);
      // Update local auth store
      const currentUser = useAuthStore.getState().user;
      if (currentUser) {
        const updated = { ...currentUser, name: data.name };
        useAuthStore.setState({ user: updated });
        localStorage.setItem('user', JSON.stringify(updated));
      }
      toast.success('Profile updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile');
    }
  };

  // Password form
  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
  });

  const handlePasswordSubmit = async (data: PasswordFormValues) => {
    try {
      await api.patch('/api/users/me/password', {
        oldPassword: data.oldPassword,
        newPassword: data.newPassword,
      });
      passwordForm.reset();
      toast.success('Password changed successfully');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to change password',
      );
    }
  };

  const inputClass = cn(
    'w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm transition-colors',
    'placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
  );

  const errorInputClass = 'border-red-300 focus:border-red-400 focus:ring-red-100';

  return (
    <div className="space-y-6">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-slate-900">Profile</h2>
        <p className="text-sm text-slate-500">
          Manage your personal information and password
        </p>
      </div>

      {/* Profile Card */}
      <div className="rounded-lg bg-white p-6 shadow-xs">
        <h3 className="mb-5 text-sm font-semibold text-slate-900">
          Personal Information
        </h3>

        {/* Avatar */}
        <div className="mb-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-avatar bg-accent-bg text-xl font-semibold text-accent">
            {initials}
          </div>
        </div>

        <form
          onSubmit={profileForm.handleSubmit(handleProfileSubmit)}
          className="space-y-5"
        >
          {/* Name */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Full Name
            </label>
            <input
              {...profileForm.register('name')}
              placeholder="Your full name"
              className={cn(
                inputClass,
                profileForm.formState.errors.name && errorInputClass,
              )}
            />
            {profileForm.formState.errors.name && (
              <p className="mt-1 text-xs text-red-500">
                {profileForm.formState.errors.name.message}
              </p>
            )}
          </div>

          {/* Email (read-only) */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Email
            </label>
            <input
              type="email"
              value={user?.email ?? ''}
              readOnly
              className={cn(inputClass, 'cursor-not-allowed bg-slate-50 text-slate-500')}
            />
            <p className="mt-1 text-xs text-slate-400">
              Email cannot be changed
            </p>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={profileForm.formState.isSubmitting}
              className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:opacity-50"
            >
              {profileForm.formState.isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save Profile
            </button>
          </div>
        </form>
      </div>

      {/* Password Card */}
      <div className="rounded-lg bg-white p-6 shadow-xs">
        <div className="mb-5 flex items-center gap-2">
          <Lock className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-900">
            Change Password
          </h3>
        </div>

        <form
          onSubmit={passwordForm.handleSubmit(handlePasswordSubmit)}
          className="space-y-5"
        >
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Current Password
            </label>
            <input
              {...passwordForm.register('oldPassword')}
              type="password"
              placeholder="Enter current password"
              className={cn(
                inputClass,
                passwordForm.formState.errors.oldPassword && errorInputClass,
              )}
            />
            {passwordForm.formState.errors.oldPassword && (
              <p className="mt-1 text-xs text-red-500">
                {passwordForm.formState.errors.oldPassword.message}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              New Password
            </label>
            <input
              {...passwordForm.register('newPassword')}
              type="password"
              placeholder="Enter new password"
              className={cn(
                inputClass,
                passwordForm.formState.errors.newPassword && errorInputClass,
              )}
            />
            {passwordForm.formState.errors.newPassword && (
              <p className="mt-1 text-xs text-red-500">
                {passwordForm.formState.errors.newPassword.message}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Confirm New Password
            </label>
            <input
              {...passwordForm.register('confirmPassword')}
              type="password"
              placeholder="Confirm new password"
              className={cn(
                inputClass,
                passwordForm.formState.errors.confirmPassword && errorInputClass,
              )}
            />
            {passwordForm.formState.errors.confirmPassword && (
              <p className="mt-1 text-xs text-red-500">
                {passwordForm.formState.errors.confirmPassword.message}
              </p>
            )}
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={passwordForm.formState.isSubmitting}
              className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:opacity-50"
            >
              {passwordForm.formState.isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              Change Password
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
