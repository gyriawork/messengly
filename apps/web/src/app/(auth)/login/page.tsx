'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { SESSION_END_REASON_KEY } from '@/lib/api';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

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
      </div>

      <p className="mt-6 text-center text-sm text-slate-400">
        Need an account? Ask your workspace admin for an invite.
      </p>
    </div>
  );
}
