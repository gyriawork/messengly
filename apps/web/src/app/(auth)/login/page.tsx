'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth';
import { useGoogleLoginStatus } from '@/hooks/useIntegrations';
import { cn } from '@/lib/utils';
import { SESSION_END_REASON_KEY } from '@/lib/api';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Server-side redirect errors (see apps/api/src/routes/auth-google.ts) mapped
// to copy a user can act on.
const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  google_not_configured: 'Google sign-in is not available right now.',
  google_denied: 'Google sign-in was cancelled.',
  google_missing_params: 'Google sign-in failed. Please try again.',
  google_invalid_state: 'Google sign-in expired. Please try again.',
  google_token_exchange_failed: 'Google sign-in failed. Please try again.',
  google_no_id_token: 'Google sign-in failed. Please try again.',
  google_invalid_token: 'Google sign-in failed. Please try again.',
  google_email_not_verified: 'Your Google account email is not verified.',
  account_not_found: 'No Messengly account found for that Google email. Ask your workspace admin for an invite.',
  account_deactivated: 'This account has been deactivated.',
  org_suspended: 'This platform is currently unavailable. Please contact us.',
};

function GoogleAuthResultHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const refreshToken = useAuthStore((s) => s.refreshToken);

  useEffect(() => {
    const googleAuth = searchParams.get('googleAuth');
    const error = searchParams.get('error');

    if (googleAuth === 'success') {
      // The API already set the httpOnly refresh cookie — no token in the URL.
      refreshToken().then((ok) => {
        if (ok) {
          toast.success('Welcome back');
          router.replace('/');
        } else {
          toast.error('Google sign-in failed. Please try again.');
          router.replace('/login');
        }
      });
      return;
    }

    if (error) {
      toast.error(GOOGLE_ERROR_MESSAGES[error] ?? 'Google sign-in failed. Please try again.');
      router.replace('/login');
    }
  }, [searchParams, router, refreshToken]);

  return null;
}

function GoogleSignInButton() {
  const { data } = useGoogleLoginStatus();
  if (!data?.available) return null;

  return (
    <>
      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-200" />
        <span className="text-xs font-medium text-slate-400">OR</span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <a
        href={`${API_BASE_URL}/api/auth/google`}
        className="flex w-full items-center justify-center gap-2 rounded-lg border-[1.5px] border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        <svg className="h-4 w-4" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
          <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
          <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
          <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
        </svg>
        Sign in with Google
      </a>
    </>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  // Explain WHY the user landed here after a forced logout (expired session,
  // suspended org) — the flag is set right before the hard redirect.
  useEffect(() => {
    try {
      const reason = sessionStorage.getItem(SESSION_END_REASON_KEY);
      if (reason) {
        sessionStorage.removeItem(SESSION_END_REASON_KEY);
        toast.error(reason);
      }
    } catch {
      // sessionStorage unavailable — nothing to explain
    }
  }, []);

  const onSubmit = async (data: LoginForm) => {
    setIsSubmitting(true);
    try {
      await login(data.email, data.password);
      toast.success('Welcome back');
      router.push('/');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid credentials';
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass = (hasError?: boolean) =>
    cn(
      'w-full rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900',
      'transition-colors placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
      hasError && 'border-red-300 focus:border-red-400 focus:ring-red-100',
    );

  return (
    <div className="w-full max-w-[400px] px-2">
      {/* useSearchParams requires a Suspense boundary in the app router */}
      <Suspense fallback={null}>
        <GoogleAuthResultHandler />
      </Suspense>

      {/* Logo — visible on mobile where the left panel is hidden */}
      <div className="mb-8 flex justify-center lg:hidden">
        <img src="/logo-dark.svg" alt="Messengly" className="h-8" />
      </div>

      <div className="rounded-2xl bg-white p-8 shadow-xs">
        <h2 className="text-2xl font-semibold text-slate-900">Welcome back</h2>
        <p className="mt-1 text-sm text-slate-500">
          Sign in to your workspace
        </p>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              className={inputClass(!!errors.email)}
              {...register('email')}
            />
            {errors.email && (
              <p className="mt-1.5 text-xs text-red-500">
                {errors.email.message}
              </p>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-slate-700"
              >
                Password
              </label>
              <button
                type="button"
                onClick={() => router.push('/forgot-password')}
                className="text-xs font-medium text-slate-400 transition-colors hover:text-accent"
              >
                Forgot password?
              </button>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Your password"
                className={cn(inputClass(!!errors.password), 'pr-10')}
                {...register('password')}
              />
              <button
                type="button"
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {errors.password && (
              <p className="mt-1.5 text-xs text-red-500">
                {errors.password.message}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Sign in
          </button>
        </form>

        <GoogleSignInButton />
      </div>

      <p className="mt-6 text-center text-sm text-slate-400">
        Need an account? Ask your workspace admin for an invite.
      </p>

      <p className="mt-3 text-center text-xs text-slate-400">
        <Link href="/privacy" className="hover:text-accent hover:underline">
          Privacy Policy
        </Link>
        <span className="mx-2">·</span>
        <Link href="/terms" className="hover:text-accent hover:underline">
          Terms of Service
        </Link>
      </p>
    </div>
  );
}
