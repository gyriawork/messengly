'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { toast } from 'sonner';

/**
 * One-time credential panel: shown right after an invite or a password reset
 * when no email could be sent, so the admin can copy the credentials and hand
 * them over. The password exists only in this response — closing the panel
 * loses it for good, hence the warning.
 */
export function CredentialReveal({
  email,
  password,
  note = "Email delivery isn't set up, so no invite was sent. Copy these credentials now and pass them on — the password won't be shown again.",
  onDone,
}: {
  email: string;
  password: string;
  note?: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${email}\n${password}`);
      setCopied(true);
      toast.success('Credentials copied');
    } catch {
      toast.error('Could not copy — select and copy the text manually');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-xs leading-relaxed text-amber-800">{note}</p>
      </div>

      <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div>
          <p className="text-xs font-medium text-slate-500">Email</p>
          <p className="select-all text-sm font-semibold text-slate-800">{email}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-slate-500">Temporary password</p>
          <p className="select-all font-mono text-sm tracking-wide text-slate-800">{password}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={copy}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy credentials'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
        >
          Done
        </button>
      </div>
    </div>
  );
}
