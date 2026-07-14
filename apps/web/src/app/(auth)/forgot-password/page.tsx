'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, MailCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

const schema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

type FormValues = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    try {
      await api.post('/api/auth/forgot-password', { email: data.email });
      setSubmitted(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong. Try again');
    }
  };

  return (
    <div className="w-full max-w-[400px] px-2">
      <div className="mb-8 flex justify-center lg:hidden">
        <img src="/logo-dark.svg" alt="Messengly" className="h-8" />
      </div>

      <div className="rounded-2xl bg-white p-8 shadow-xs">
        {submitted ? (
          <div className="text-center">
            <MailCheck className="mx-auto h-10 w-10 text-emerald-500" />
            <h2 className="mt-4 text-xl font-semibold text-slate-900">Check your inbox</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              If an account exists for that email, a reset link is on its way. It stays valid
              for one hour.
            </p>
            <p className="mt-3 text-xs text-slate-400">
              Nothing arrived? Ask your workspace admin to reset your password.
            </p>
          </div>
        ) : (
          <>
            <h2 className="text-2xl font-semibold text-slate-900">Reset your password</h2>
            <p className="mt-1 text-sm text-slate-500">
              Enter your email and we&apos;ll send you a reset link
            </p>

            <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  className={cn(
                    'w-full rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900',
                    'transition-colors placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
                    errors.email && 'border-red-300 focus:border-red-400 focus:ring-red-100',
                  )}
                  {...register('email')}
                />
                {errors.email && (
                  <p className="mt-1.5 text-xs text-red-500">{errors.email.message}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
              >
                {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Send reset link
              </button>
            </form>
          </>
        )}
      </div>

      <p className="mt-6 text-center text-sm text-slate-400">
        <Link href="/login" className="inline-flex items-center gap-1 transition-colors hover:text-accent">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
