'use client';

import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

const schema = z
  .object({
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type FormValues = z.infer<typeof schema>;

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [showPassword, setShowPassword] = useState(false);
  const [invalidToken, setInvalidToken] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    if (!token) return;
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: data.newPassword });
      toast.success('Password updated — sign in with your new password');
      router.push('/login');
    } catch {
      setInvalidToken(true);
    }
  };

  const inputClass = (hasError?: boolean) =>
    cn(
      'w-full rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900',
      'transition-colors placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
      hasError && 'border-red-300 focus:border-red-400 focus:ring-red-100',
    );

  if (!token || invalidToken) {
    return (
      <div className="text-center">
        <h2 className="text-xl font-semibold text-slate-900">
          This reset link isn&apos;t valid anymore
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          The link may have expired (links stay valid for one hour) or was already used.
        </p>
        <Link
          href="/forgot-password"
          className="mt-5 inline-block rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <>
      <h2 className="text-2xl font-semibold text-slate-900">Set a new password</h2>
      <p className="mt-1 text-sm text-slate-500">Pick a password of at least 8 characters</p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
        <div>
          <label htmlFor="newPassword" className="mb-1.5 block text-sm font-medium text-slate-700">
            New password
          </label>
          <div className="relative">
            <input
              id="newPassword"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="New password"
              className={cn(inputClass(!!errors.newPassword), 'pr-10')}
              {...register('newPassword')}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {errors.newPassword && (
            <p className="mt-1.5 text-xs text-red-500">{errors.newPassword.message}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="confirmPassword"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            Confirm password
          </label>
          <input
            id="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="Repeat the new password"
            className={inputClass(!!errors.confirmPassword)}
            {...register('confirmPassword')}
          />
          {errors.confirmPassword && (
            <p className="mt-1.5 text-xs text-red-500">{errors.confirmPassword.message}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Update password
        </button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="w-full max-w-[400px] px-2">
      <div className="mb-8 flex justify-center lg:hidden">
        <img src="/logo-dark.svg" alt="Messengly" className="h-8" />
      </div>

      <div className="rounded-2xl bg-white p-8 shadow-xs">
        {/* useSearchParams requires a Suspense boundary in the app router */}
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </div>

      <p className="mt-6 text-center text-sm text-slate-400">
        <Link
          href="/login"
          className="inline-flex items-center gap-1 transition-colors hover:text-accent"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
