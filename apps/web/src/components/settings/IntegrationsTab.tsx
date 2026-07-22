'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Plug,
  Unplug,
  X,
  Loader2,
  Info,
  Settings,
  ChevronDown,
  ExternalLink,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { humanizeError } from '@/lib/errors';
import { formatDateTime } from '@/lib/dates';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { getAccessToken } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useSuperadminStore } from '@/stores/superadmin';
import {
  useIntegrations,
  useConnectIntegration,
  useDisconnectIntegration,
  useReconnectIntegration,
  useUpdateIntegrationSettings,
  useSlackOAuthStatus,
  useGmailOAuthAvailable,
  useTelegramConnectSession,
  useTelegramQrStart,
  useTelegramQrStatus,
  useTelegramQr2fa,
} from '@/hooks/useIntegrations';
import { useWhatsAppPairing, type WhatsAppPairingStatus } from '@/hooks/useWhatsAppPairing';
import { useAvailableIntegrations } from '@/hooks/useAvailableIntegrations';
import { useOrgMessengerConfig } from '@/hooks/useOrgMessengerConfig';
import { OrgMessengerConfigCard } from './OrgMessengerConfigCard';
import type { Integration, IntegrationStatus, MessengerType } from '@/types/integration';
import { ConnectAndImportWizard } from './ConnectAndImportWizard';
import { TeamsRemoteLogin } from './TeamsRemoteLogin';

// ---------- Messenger metadata ----------

export interface MessengerInfo {
  key: MessengerType;
  name: string;
  abbr: string;
  description: string;
  bgClass: string;
  textClass: string;
  badgeBg: string;
}

export const messengers: MessengerInfo[] = [
  {
    key: 'telegram',
    name: 'Telegram',
    abbr: 'TG',
    description: 'Send and receive messages via Telegram user account',
    bgClass: 'bg-messenger-tg-bg',
    textClass: 'text-messenger-tg-text',
    badgeBg: 'bg-messenger-tg-bg',
  },
  {
    key: 'slack',
    name: 'Slack',
    abbr: 'SL',
    description: 'Connect to Slack workspaces and channels',
    bgClass: 'bg-messenger-sl-bg',
    textClass: 'text-messenger-sl-text',
    badgeBg: 'bg-messenger-sl-bg',
  },
  {
    key: 'whatsapp',
    name: 'WhatsApp',
    abbr: 'WA',
    description: 'Message contacts via WhatsApp Web pairing',
    bgClass: 'bg-messenger-wa-bg',
    textClass: 'text-messenger-wa-text',
    badgeBg: 'bg-messenger-wa-bg',
  },
  {
    key: 'teams',
    name: 'MS Teams',
    abbr: 'MT',
    description: 'Broadcast to Teams chats through a signed-in browser session',
    bgClass: 'bg-messenger-mt-bg',
    textClass: 'text-messenger-mt-text',
    badgeBg: 'bg-messenger-mt-bg',
  },
  // Gmail intentionally hidden — service is focused on Slack/Telegram broadcasts.
];

// ---------- Status helpers ----------

function statusConfig(status: IntegrationStatus) {
  switch (status) {
    case 'connected':
      return {
        label: 'Connected',
        dotClass: 'bg-emerald-500',
        badgeClass: 'bg-emerald-50 text-emerald-700',
        icon: CheckCircle2,
      };
    case 'disconnected':
      return {
        label: 'Disconnected',
        dotClass: 'bg-slate-400',
        badgeClass: 'bg-slate-100 text-slate-600',
        icon: XCircle,
      };
    case 'token_expired':
      return {
        label: 'Token Expired',
        dotClass: 'bg-amber-500',
        badgeClass: 'bg-amber-50 text-amber-700',
        icon: AlertTriangle,
      };
    case 'session_expired':
      return {
        label: 'Session Expired',
        dotClass: 'bg-red-500',
        badgeClass: 'bg-red-50 text-red-700',
        icon: AlertTriangle,
      };
  }
}



// ---------- Zod schemas for connect forms ----------

const telegramSessionSchema = z.object({
  session: z.string().min(1, 'Session key is required'),
  phoneNumber: z.string().optional(),
});

const slackSchema = z.object({
  botToken: z.string().min(1, 'Bot Token is required').startsWith('xoxb-', 'Must start with xoxb-'),
});


// ---------- Connect modals ----------

function TelegramConnectForm({
  onSuccess,
  forUserId,
}: {
  onSuccess: () => void;
  /** Admin+ connecting on behalf of another org member (Team card). */
  forUserId?: string;
}) {
  // QR-code login is the primary method — no verification code is involved.
  // Session-key paste is kept as a fallback.
  const [mode, setMode] = useState<'qr' | 'session'>('qr');
  const [done, setDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // ── QR login ──
  const qrStart = useTelegramQrStart();
  const qr2fa = useTelegramQr2fa();
  const [qrActive, setQrActive] = useState(false);
  const [twoFaPassword, setTwoFaPassword] = useState('');
  const { data: qrStatus } = useTelegramQrStatus(mode === 'qr' && qrActive && !done);

  const beginQr = () => {
    setErrorMessage(null);
    setQrActive(false);
    qrStart.mutate(forUserId, {
      onSuccess: () => setQrActive(true),
      onError: (err) =>
        setErrorMessage(humanizeError(err, 'Failed to start QR login')),
    });
  };

  // Start a QR login when entering QR mode.
  useEffect(() => {
    if (mode === 'qr' && !done) beginQr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // React to status changes from polling.
  useEffect(() => {
    if (!qrStatus) return;
    if (qrStatus.status === 'connected') {
      setQrActive(false);
      setDone(true);
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      toast.success('Telegram connected successfully!');
      onSuccess();
    } else if (qrStatus.status === 'error') {
      setQrActive(false);
      setErrorMessage(qrStatus.error || 'QR login failed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrStatus?.status, qrStatus?.error]);

  const submit2fa = () => {
    const pw = twoFaPassword.trim();
    if (!pw) return;
    setTwoFaPassword('');
    qr2fa.mutate(pw, {
      onError: (err) =>
        setErrorMessage(humanizeError(err, 'Failed to submit 2FA password')),
    });
  };

  // ── Session key (fallback) ──
  const connectSessionMutation = useTelegramConnectSession();
  const sessionForm = useForm<z.infer<typeof telegramSessionSchema>>({
    resolver: zodResolver(telegramSessionSchema),
  });
  const handleSession = (data: z.infer<typeof telegramSessionSchema>) => {
    setErrorMessage(null);
    connectSessionMutation.mutate(
      { session: data.session.trim(), phoneNumber: data.phoneNumber?.trim() || undefined, forUserId },
      {
        onSuccess: () => {
          setDone(true);
          toast.success('Telegram connected successfully!');
          onSuccess();
        },
        onError: (err) =>
          setErrorMessage(humanizeError(err, 'Invalid or expired session key')),
      },
    );
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <p className="text-sm font-medium text-slate-700">Telegram connected successfully!</p>
      </div>
    );
  }

  // ── QR mode (primary) ──
  if (mode === 'qr') {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg bg-blue-50 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
          <div className="space-y-1 text-xs text-blue-700">
            <p className="font-medium">Scan to connect, no code needed</p>
            <p>
              On your phone: <b>Telegram → Settings → Devices → Link Desktop Device</b>, then scan
              this QR.
            </p>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center py-2">
          {qrStatus?.needs2FA ? (
            <div className="w-full space-y-2">
              <label className="block text-sm font-medium text-slate-700">2FA password</label>
              <input
                type="password"
                value={twoFaPassword}
                onChange={(e) => setTwoFaPassword(e.target.value)}
                placeholder="Your Telegram 2FA password"
                className="w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
              />
              <button
                type="button"
                onClick={submit2fa}
                disabled={qr2fa.isPending}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover disabled:opacity-50"
              >
                {qr2fa.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Submit 2FA password
              </button>
            </div>
          ) : qrStatus?.qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrStatus.qr}
              alt="Telegram login QR code"
              className="h-[240px] w-[240px] rounded-lg border border-slate-200"
            />
          ) : (
            <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg border border-dashed border-slate-200">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          )}
        </div>

        {errorMessage && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">{errorMessage}</p>
          </div>
        )}

        {errorMessage && (
          <button
            type="button"
            onClick={beginQr}
            className="flex w-full items-center justify-center gap-2 rounded-lg border-[1.5px] border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
          >
            Try again
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            setMode('session');
            setErrorMessage(null);
            setQrActive(false);
          }}
          className="w-full text-center text-xs text-slate-400 transition-colors hover:text-slate-600"
        >
          Advanced: connect with a session key instead
        </button>
      </div>
    );
  }

  // ── Session-key mode (fallback) ──
  return (
    <form onSubmit={sessionForm.handleSubmit(handleSession)} className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-blue-50 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <div className="space-y-1 text-xs text-blue-700">
          <p className="font-medium">Connect with a session key</p>
          <p>
            Generate it once on your own computer, then paste it here. Run from the{' '}
            <code className="rounded bg-blue-100 px-1">apps/api</code> folder:
          </p>
          <code className="block rounded bg-blue-100 px-2 py-1 font-mono">
            npx tsx scripts/generate-telegram-session.ts
          </code>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-700">Session key</label>
        <textarea
          {...sessionForm.register('session')}
          rows={4}
          placeholder="Paste the StringSession key here"
          className={cn(
            'w-full break-all rounded-lg border-[1.5px] border-slate-200 px-3 py-2 font-mono text-xs transition-colors',
            'placeholder:font-sans placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
            sessionForm.formState.errors.session && 'border-red-300 focus:border-red-400 focus:ring-red-100',
          )}
        />
        {sessionForm.formState.errors.session && (
          <p className="mt-1 text-xs text-red-500">{sessionForm.formState.errors.session.message}</p>
        )}
      </div>

      {errorMessage && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <p className="text-xs text-red-700">{errorMessage}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={connectSessionMutation.isPending}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] hover:bg-accent-hover disabled:opacity-50"
      >
        {connectSessionMutation.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plug className="h-4 w-4" />
        )}
        Connect with session key
      </button>

      <button
        type="button"
        onClick={() => {
          setMode('qr');
          setErrorMessage(null);
        }}
        className="w-full text-center text-xs text-slate-400 transition-colors hover:text-slate-600"
      >
        ← Back to QR code (recommended)
      </button>
    </form>
  );
}

function SlackConnectForm({
  onSubmit,
  isPending,
  forUserId,
}: {
  onSubmit: (data: z.infer<typeof slackSchema>) => void;
  isPending: boolean;
  /** Admin+ connecting on behalf of another org member (Team card). */
  forUserId?: string;
}) {
  const { data: oauthStatus, isLoading: oauthLoading } = useSlackOAuthStatus();
  const [showManualToken, setShowManualToken] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof slackSchema>>({
    resolver: zodResolver(slackSchema),
  });

  const oauthConfigured = oauthStatus?.oauthConfigured ?? false;

  const handleOAuthConnect = async (mode: 'bot' | 'user') => {
    const token = await getAccessToken();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    let url = `${apiUrl}/api/oauth/slack/authorize?token=${encodeURIComponent(token ?? '')}&mode=${mode}`;
    const orgId = useSuperadminStore.getState().selectedOrgId;
    if (orgId) {
      url += `&organizationId=${encodeURIComponent(orgId)}`;
    }
    if (forUserId) {
      url += `&forUserId=${encodeURIComponent(forUserId)}`;
    }
    window.location.href = url;
  };

  if (oauthLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* OAuth connect button — shown when OAuth is configured */}
      {oauthConfigured && (
        <>
          <div className="flex items-start gap-2 rounded-lg bg-blue-50 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
            <p className="text-xs text-blue-700">
              Choose how messages should be sent. You will be redirected to
              Slack to grant access, then returned here automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleOAuthConnect('bot')}
            className="flex w-full items-center justify-center gap-2 rounded bg-[#4A154B] px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-[#3a1139] hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
          >
            <ExternalLink className="h-4 w-4" />
            Connect as bot — messages send from the app
          </button>
          <button
            type="button"
            onClick={() => handleOAuthConnect('user')}
            className="flex w-full items-center justify-center gap-2 rounded border-[1.5px] border-[#4A154B] px-4 py-2.5 text-sm font-medium text-[#4A154B] transition-all hover:bg-[#4A154B]/5 hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
          >
            <ExternalLink className="h-4 w-4" />
            Connect as my Slack account — messages send as me
          </button>

          {/* Expandable manual token section */}
          <div className="border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => setShowManualToken(!showManualToken)}
              className="flex w-full items-center gap-2 text-xs font-medium text-slate-500 transition-colors hover:text-slate-700"
            >
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 transition-transform duration-200',
                  showManualToken && 'rotate-180',
                )}
              />
              Advanced: Use Bot Token
            </button>
          </div>
        </>
      )}

      {/* Manual token form — shown when OAuth is not configured, or user expands advanced section */}
      {(!oauthConfigured || showManualToken) && (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {oauthConfigured && (
            <p className="text-xs text-slate-500">
              If you prefer, you can manually enter a Slack Bot Token instead of using OAuth.
            </p>
          )}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Bot Token
            </label>
            <input
              {...register('botToken')}
              type="password"
              placeholder="xoxb-your-bot-token"
              className={cn(
                'w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm font-mono transition-colors',
                'placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
                errors.botToken && 'border-red-300 focus:border-red-400 focus:ring-red-100',
              )}
            />
            {errors.botToken && (
              <p className="mt-1 text-xs text-red-500">{errors.botToken.message}</p>
            )}
          </div>
          <button
            type="submit"
            disabled={isPending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:opacity-50"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            Connect with Token
          </button>
        </form>
      )}
    </div>
  );
}

function WhatsAppConnectForm({
  onClose,
  forUserId,
}: {
  onClose: () => void;
  /** Admin+ connecting on behalf of another org member (Team card). */
  forUserId?: string;
}) {
  const {
    status,
    qrDataUrl,
    statusMessage,
    error,
    startPairing,
    cancelPairing,
    reset,
  } = useWhatsAppPairing();

  return (
    <div className="space-y-4">
      {status === 'idle' && (
        <>
          <div className="flex items-start gap-2 rounded-lg bg-emerald-50 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <p className="text-xs text-emerald-700">
              WhatsApp uses QR code pairing. After clicking Connect, a QR code
              will appear. Scan it with WhatsApp on your phone to link this
              device.
            </p>
          </div>
          <button
            onClick={() => startPairing(forUserId)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
          >
            <Plug className="h-4 w-4" />
            Start QR Pairing
          </button>
        </>
      )}
      {(status === 'starting' || status === 'waiting_for_qr') && (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
          <p className="text-sm text-slate-600">{statusMessage || 'Generating QR code...'}</p>
          <button
            onClick={cancelPairing}
            className="mt-2 text-xs text-slate-400 underline hover:text-slate-600"
          >
            Cancel
          </button>
        </div>
      )}
      {status === 'qr_ready' && qrDataUrl && (
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-lg border-2 border-emerald-200 bg-white p-2">
            <img src={qrDataUrl} alt="WhatsApp QR Code" width={280} height={280} className="block" />
          </div>
          <p className="text-center text-sm text-slate-600">
            {statusMessage || 'Scan with WhatsApp on your phone'}
          </p>
          <p className="text-center text-xs text-slate-400">
            Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
          </p>
          <button
            onClick={cancelPairing}
            className="mt-1 text-xs text-slate-400 underline hover:text-slate-600"
          >
            Cancel
          </button>
        </div>
      )}
      {status === 'connecting' && (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
          <p className="text-sm text-slate-600">Connecting to WhatsApp...</p>
        </div>
      )}
      {status === 'connected' && (
        <div className="flex flex-col items-center gap-3 py-6">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="text-sm font-medium text-emerald-700">WhatsApp connected successfully!</p>
          <button
            onClick={onClose}
            className="mt-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover"
          >
            Done
          </button>
        </div>
      )}
      {status === 'error' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">{error || 'An error occurred during pairing'}</p>
          </div>
          <button
            onClick={() => { reset(); startPairing(forUserId); }}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

const GMAIL_IMPORT_COUNTS = [10, 20, 50, 100, 200, 500] as const;

function GmailConnectForm({ forUserId }: {
  onSubmit: (data: Record<string, string>) => void;
  isPending: boolean;
  /** Admin+ connecting on behalf of another org member (Team card). */
  forUserId?: string;
}) {
  const { data: oauthData, isLoading: oauthLoading } = useGmailOAuthAvailable();
  const [importCount, setImportCount] = useState<number>(50);

  const oauthAvailable = oauthData?.available ?? false;

  const handleOAuthConnect = async () => {
    const token = await getAccessToken();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    let url = `${apiUrl}/api/oauth/gmail/authorize?token=${encodeURIComponent(token ?? '')}&importCount=${importCount}`;
    // Superadmin: inject selected org context (window.location.href bypasses api.ts interceptor)
    const orgId = useSuperadminStore.getState().selectedOrgId;
    if (orgId) {
      url += `&organizationId=${encodeURIComponent(orgId)}`;
    }
    if (forUserId) {
      url += `&forUserId=${encodeURIComponent(forUserId)}`;
    }
    window.location.href = url;
  };

  if (oauthLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!oauthAvailable) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs text-amber-700">
            Gmail integration is not configured yet. Please contact your administrator
            to set up Google OAuth credentials on the server.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-blue-50 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <p className="text-xs text-blue-700">
          After connecting, your recent emails will be automatically imported.
          Each email thread becomes a separate chat.
        </p>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-600">
          Import last emails
        </label>
        <select
          value={importCount}
          onChange={(e) => setImportCount(Number(e.target.value))}
          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition-colors focus:border-accent focus:bg-white"
        >
          {GMAIL_IMPORT_COUNTS.map((count) => (
            <option key={count} value={count}>
              {count} emails
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        onClick={handleOAuthConnect}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#4285F4] px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-[#3367D6] hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
      >
        <ExternalLink className="h-4 w-4" />
        Connect with Google
      </button>
    </div>
  );
}

// ---------- Connect Modal Wrapper ----------

export function ConnectModal({
  messenger,
  onClose,
  forUserId,
  forUserName,
}: {
  messenger: MessengerInfo;
  onClose: () => void;
  /** Admin+ connecting on behalf of another org member (Team card). */
  forUserId?: string;
  forUserName?: string;
}) {
  const connectMutation = useConnectIntegration();

  const handleConnect = (payload: Record<string, string>) => {
    connectMutation.mutate(
      { messenger: messenger.key, payload: payload as never, forUserId },
      {
        onSuccess: () => {
          toast.success(
            forUserId
              ? `${messenger.name} connected for ${forUserName ?? 'user'}`
              : `${messenger.name} connected successfully`,
          );
          onClose();
        },
        onError: (error) => {
          toast.error(
            humanizeError(error, 'Failed to connect'),
          );
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm motion-safe:animate-overlay-in md:items-center">
      <div
        className={cn(
          'w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-lg motion-safe:animate-modal-in md:rounded-xl',
          // Teams renders a live 1600×900 remote browser the operator clicks around in.
          messenger.key === 'teams' ? 'md:max-w-6xl' : 'md:max-w-md',
        )}
      >
        {/* Modal header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MessengerIcon messenger={messenger.key} size={40} />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Connect {messenger.name}
              </h3>
              <p className="text-xs text-slate-500">
                {forUserId ? `For ${forUserName ?? 'this teammate'} — ${messenger.description}` : messenger.description}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Messenger-specific form */}
        {messenger.key === 'telegram' && (
          <TelegramConnectForm onSuccess={onClose} forUserId={forUserId} />
        )}
        {messenger.key === 'slack' && (
          <SlackConnectForm
            onSubmit={handleConnect}
            isPending={connectMutation.isPending}
            forUserId={forUserId}
          />
        )}
        {messenger.key === 'whatsapp' && (
          <WhatsAppConnectForm onClose={onClose} forUserId={forUserId} />
        )}
        {messenger.key === 'gmail' && (
          <GmailConnectForm
            onSubmit={handleConnect}
            isPending={connectMutation.isPending}
            forUserId={forUserId}
          />
        )}
        {messenger.key === 'teams' && <TeamsRemoteLogin onClose={onClose} forUserId={forUserId} />}
      </div>
    </div>
  );
}

// ---------- Integration Settings Modal ----------

function IntegrationSettingsModal({
  messenger,
  integration,
  onClose,
}: {
  messenger: MessengerInfo;
  integration: Integration;
  onClose: () => void;
}) {
  const updateSettingsMutation = useUpdateIntegrationSettings();
  const [settingsJson, setSettingsJson] = useState(() => {
    try {
      return JSON.stringify(integration.settings ?? {}, null, 2);
    } catch {
      return '{}';
    }
  });
  const [jsonError, setJsonError] = useState<string | null>(null);

  const handleSave = () => {
    try {
      const parsed = JSON.parse(settingsJson);
      setJsonError(null);
      updateSettingsMutation.mutate(
        { messenger: messenger.key, settings: parsed },
        {
          onSuccess: () => {
            toast.success(`${messenger.name} settings saved`);
            onClose();
          },
          onError: (err) =>
            toast.error(
              humanizeError(err, 'Failed to save settings'),
            ),
        },
      );
    } catch {
      setJsonError('Invalid JSON format');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm motion-safe:animate-overlay-in md:items-center">
      <div className="w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-lg motion-safe:animate-modal-in md:max-w-lg md:rounded-xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MessengerIcon messenger={messenger.key} size={40} />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                {messenger.name} Settings
              </h3>
              <p className="text-xs text-slate-500">
                Configure integration settings
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            Settings (JSON)
          </label>
          <textarea
            value={settingsJson}
            onChange={(e) => {
              setSettingsJson(e.target.value);
              setJsonError(null);
            }}
            rows={10}
            className={cn(
              'w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 font-mono text-sm transition-colors',
              'placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
              jsonError && 'border-red-300 focus:border-red-400 focus:ring-red-100',
            )}
          />
          {jsonError && (
            <p className="text-xs text-red-500">{jsonError}</p>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={updateSettingsMutation.isPending}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:opacity-50"
          >
            {updateSettingsMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Integration Card ----------

function IntegrationCard({
  info,
  integration,
  onConnect,
  onSettings,
}: {
  info: MessengerInfo;
  integration?: Integration;
  onConnect: () => void;
  onSettings: () => void;
}) {
  const disconnectMutation = useDisconnectIntegration();
  const reconnectMutation = useReconnectIntegration();

  const status: IntegrationStatus = integration?.status ?? 'disconnected';
  const config = statusConfig(status);
  const isConnected = status === 'connected';
  const needsAttention = status === 'token_expired' || status === 'session_expired';

  const handleDisconnect = () => {
    disconnectMutation.mutate(info.key, {
      onSuccess: () => toast.success(`${info.name} disconnected`),
      onError: (err) =>
        toast.error(humanizeError(err, 'Failed to disconnect')),
    });
  };

  const handleReconnect = () => {
    reconnectMutation.mutate(info.key, {
      onSuccess: () => toast.success(`${info.name} reconnected successfully`),
      onError: (err) =>
        toast.error(humanizeError(err, 'Failed to reconnect')),
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-xs sm:p-5">
      <div className="flex flex-wrap items-center gap-4">
        {/* Identity */}
        <MessengerIcon messenger={info.key} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">
              {info.name}
            </h3>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
                config.badgeClass,
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', config.dotClass)} />
              {config.label}
            </span>
            {info.key === 'slack' && isConnected && (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                {(integration?.settings as { sendAs?: 'bot' | 'user' } | undefined)?.sendAs === 'user' ? 'personal' : 'bot'}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">{info.description}</p>
          {integration && status !== 'disconnected' && (
            <p className="mt-0.5 text-xs text-slate-500">
              Connected since{' '}
              <span className="font-medium text-slate-600">
                {formatDateTime(integration.connectedAt)}
              </span>
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-2">
          {status === 'disconnected' ? (
            <button
              onClick={onConnect}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
            >
              <Plug className="h-4 w-4" />
              Connect
            </button>
          ) : (
            <>
              <button
                onClick={handleReconnect}
                disabled={reconnectMutation.isPending}
                className={cn(
                  'flex items-center gap-2 rounded-lg border-[1.5px] px-3 py-2 text-sm font-medium transition-all hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]',
                  needsAttention
                    ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                    : 'border-slate-200 text-slate-700 hover:bg-slate-50',
                )}
              >
                {reconnectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Reconnect
              </button>
              <button
                onClick={onSettings}
                className="flex items-center gap-2 rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition-all hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] hover:bg-slate-50"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>
              <button
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending}
                className="flex items-center gap-2 rounded-lg border-[1.5px] border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-all hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] hover:bg-red-50"
              >
                {disconnectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Unplug className="h-4 w-4" />
                )}
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>

      {/* Expired-session warning spans the full row */}
      {needsAttention && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs text-amber-700">
            {status === 'token_expired'
              ? 'Your access token has expired. Reconnect to keep messaging.'
              : 'Your session has expired. Reconnect to keep messaging.'}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- FAQ Data ----------

export interface FaqStep {
  text: string;
  link?: { url: string; label: string };
}

export interface FaqItem {
  messenger: MessengerType;
  title: string;
  abbr: string;
  bgClass: string;
  textClass: string;
  steps: FaqStep[];
}

export const faqItems: FaqItem[] = [
  {
    messenger: 'telegram',
    title: 'How to connect Telegram',
    abbr: 'TG',
    bgClass: 'bg-messenger-tg-bg',
    textClass: 'text-messenger-tg-text',
    steps: [
      { text: 'Click "Connect" on the Telegram card above — a QR code appears, no phone number or code needed.' },
      { text: 'On your phone: Telegram → Settings → Devices → Link Desktop Device.' },
      { text: 'Point your phone camera at the QR code shown on screen.' },
      { text: 'If you have two-factor authentication enabled, enter your 2FA password when prompted.' },
      { text: 'Once scanned, your Telegram account connects automatically — no further steps needed.' },
      { text: 'QR not working? Expand "Advanced: connect with a session key instead" to paste a pre-generated session key.' },
    ],
  },
  {
    messenger: 'slack',
    title: 'How to connect Slack',
    abbr: 'SL',
    bgClass: 'bg-messenger-sl-bg',
    textClass: 'text-messenger-sl-text',
    steps: [
      { text: 'Click "Connect" on the Slack card above, then click "Connect with Slack".' },
      { text: 'You will be redirected to Slack. Sign in if needed, then review and authorize the requested permissions.' },
      { text: 'After authorizing, you will be redirected back here automatically. Your Slack workspace will be connected.' },
      {
        text: 'Alternatively, if OAuth is not available, expand "Advanced: Use Bot Token" and paste a bot token manually (starts with xoxb-). See the Slack API docs to create one.',
        link: { url: 'https://api.slack.com/apps', label: 'api.slack.com/apps' },
      },
    ],
  },
  {
    messenger: 'whatsapp',
    title: 'How to connect WhatsApp',
    abbr: 'WA',
    bgClass: 'bg-messenger-wa-bg',
    textClass: 'text-messenger-wa-text',
    steps: [
      { text: 'Make sure WhatsApp is installed and active on your phone.' },
      { text: 'Click "Connect" on the WhatsApp card on this page.' },
      { text: 'A QR code will be displayed on screen.' },
      { text: 'Open WhatsApp on your phone, go to Settings (or Menu) > Linked Devices > Link a Device.' },
      { text: 'Point your phone camera at the QR code on this screen.' },
      { text: 'Wait for the connection to be established. It may take a few seconds.' },
      { text: 'Once linked, your WhatsApp chats will be available for import. The session stays active as long as your phone has internet access.' },
    ],
  },
  {
    messenger: 'teams',
    title: 'How to connect MS Teams',
    abbr: 'MT',
    bgClass: 'bg-messenger-mt-bg',
    textClass: 'text-messenger-mt-text',
    steps: [
      { text: 'Click "Connect" — Teams has no API login for personal accounts, so a browser opens on the server and streams its screen to you here.' },
      { text: 'Click into the picture and sign in exactly as you normally would, including any two-factor codes.' },
      { text: 'Microsoft may show a space picker ("Личное" / organization) — pick your personal account.' },
      { text: 'Wait until your chat list actually appears in the streamed browser.' },
      { text: 'Press "Save session" — this is required, the connection is not saved automatically.' },
      { text: 'Each teammate who connects their own Teams gets an isolated session — connecting yours never disturbs anyone else’s.' },
    ],
  },
  // Gmail FAQ intentionally hidden — service is focused on Slack/Telegram broadcasts.
];

// ---------- FAQ Section Component ----------

function FaqSection() {
  const [openItem, setOpenItem] = useState<MessengerType | null>(null);

  return (
    <div className="mt-10 space-y-4">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-slate-900">
          Frequently Asked Questions
        </h2>
        <p className="text-sm text-slate-500">
          Step-by-step guides for connecting each messenger.
        </p>
      </div>

      <div className="space-y-3">
        {faqItems.map((item) => {
          const isOpen = openItem === item.messenger;

          return (
            <div
              key={item.messenger}
              className="overflow-hidden rounded-lg bg-white shadow-xs transition-shadow hover:shadow-sm"
            >
              {/* Accordion header */}
              <button
                onClick={() => setOpenItem(isOpen ? null : item.messenger)}
                className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50"
              >
                <MessengerIcon messenger={item.messenger} size={32} />
                <span className="flex-1 text-sm font-medium text-slate-800">
                  {item.title}
                </span>
                <svg
                  className={cn(
                    'h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200',
                    isOpen && 'rotate-180',
                  )}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Accordion content — grid-rows animates open/close cheaply */}
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out"
                style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
              >
                <div className={cn('min-h-0 overflow-hidden px-5', isOpen ? 'border-t border-slate-100 pb-5 pt-4' : '')}>
                  <ol className="space-y-3">
                    {item.steps.map((step, idx) => (
                      <li key={idx} className="flex gap-3">
                        <span
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                            item.bgClass,
                            item.textClass,
                          )}
                        >
                          {idx + 1}
                        </span>
                        <div className="pt-0.5 text-sm leading-relaxed text-slate-600">
                          {step.text}
                          {step.link && (
                            <>
                              {' '}
                              <a
                                href={step.link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent-hover hover:decoration-accent"
                              >
                                {step.link.label}
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Main Component ----------

interface IntegrationsTabProps {
  autoOpenMessenger?: string | null;
  onAutoOpenHandled?: () => void;
}

export function IntegrationsTab({ autoOpenMessenger, onAutoOpenHandled }: IntegrationsTabProps = {}) {
  const { data, isLoading } = useIntegrations();
  const { data: availableData } = useAvailableIntegrations();
  const { data: orgConfigData } = useOrgMessengerConfig();
  const me = useAuthStore((s) => s.user);
  // Gmail is intentionally hidden from settings/connections (Task 2).
  const visibleOrgConfig = orgConfigData?.filter((entry) => entry.messenger !== 'gmail') ?? [];
  const connectMutation = useConnectIntegration();
  const [connectingMessenger, setConnectingMessenger] =
    useState<MessengerInfo | null>(null);
  const [settingsMessenger, setSettingsMessenger] =
    useState<MessengerInfo | null>(null);

  const integrationsByMessenger = useMemo(() =>
    (data?.integrations ?? []).reduce<Record<string, Integration>>((acc, int) => {
      // GET /integrations returns every row for the org (orderBy createdAt
      // desc) — more than one can exist per messenger since per-user
      // connections landed. The status card for a messenger must reflect
      // MY OWN connection when I have one, not whichever row happened to
      // win the iteration order. Priority: my own row > the org-shared
      // (scope:'org') row > whatever was seen first.
      const current = acc[int.messenger];
      if (!current) {
        acc[int.messenger] = int;
      } else if (int.userId === me?.id) {
        acc[int.messenger] = int;
      } else if (current.userId !== me?.id && int.scope === 'org' && current.scope !== 'org') {
        acc[int.messenger] = int;
      }
      return acc;
    }, {}),
    [data?.integrations, me?.id],
  );

  // Auto-open wizard after OAuth redirect (e.g. Slack, Gmail)
  // Wait until the integration actually shows as "connected" before opening,
  // to avoid a race where cached data still says "disconnected".
  useEffect(() => {
    if (!autoOpenMessenger || isLoading || !data) return;
    // Search in raw data array to avoid stale object reference
    const integration = data.integrations?.find(
      (i) => i.messenger === autoOpenMessenger && i.status === 'connected',
    );
    if (integration) {
      const info = messengers.find((m) => m.key === autoOpenMessenger);
      if (info) setConnectingMessenger(info);
      onAutoOpenHandled?.();
    }
    // If not connected yet, keep waiting — React Query will refetch
  }, [autoOpenMessenger, isLoading, data, onAutoOpenHandled]);

  // Show messengers that are available (platform configured) or already connected
  const availableSet = new Set(availableData?.available ?? []);
  const visibleMessengers = messengers.filter(
    (m) => availableSet.has(m.key) || integrationsByMessenger[m.key],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <>
      {visibleOrgConfig.length > 0 && (
        <div className="mb-6 space-y-4">
          <div className="mb-2">
            <h2 className="text-base font-semibold text-slate-900">
              Messenger App Credentials
            </h2>
            <p className="text-sm text-slate-500">
              Your organization&apos;s own API credentials (e.g. Telegram API Hash &amp; ID).
              Falls back to the platform default when not set.
            </p>
          </div>
          <div className="space-y-3">
            {visibleOrgConfig.map((entry) => (
              <OrgMessengerConfigCard key={entry.messenger} entry={entry} />
            ))}
          </div>
        </div>
      )}
      <div className="space-y-4">
        <div className="mb-2">
          <h2 className="text-base font-semibold text-slate-900">
            Connected Accounts
          </h2>
          <p className="text-sm text-slate-500">
            Connect your messengers here. Everything else builds on them.
          </p>
        </div>

        {visibleMessengers.length === 0 && (
          <div className="rounded-lg bg-amber-50 p-4 text-center">
            <p className="text-sm text-amber-700">
              There\u2019s nothing to connect yet. Ask your administrator to set up the platform keys first.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {visibleMessengers.map((m, i) => (
            <div key={m.key} className="motion-safe:animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
            <IntegrationCard
              info={m}
              integration={integrationsByMessenger[m.key]}
              onConnect={() => setConnectingMessenger(m)}
              onSettings={() => setSettingsMessenger(m)}
            />
            </div>
          ))}
        </div>
      </div>

      {/* FAQ Section */}
      <FaqSection />

      {/* Teams connect only saves the browser session; chats are imported later
          via Chats → Import Chats, the same as every other messenger. */}
      {connectingMessenger && connectingMessenger.key === 'teams' && (
        <ConnectModal
          messenger={connectingMessenger}
          onClose={() => setConnectingMessenger(null)}
        />
      )}

      {/* Connect + Import wizard */}
      {connectingMessenger && connectingMessenger.key !== 'teams' && (
        <ConnectAndImportWizard
          messenger={connectingMessenger.key}
          messengerName={connectingMessenger.name}
          isAlreadyConnected={integrationsByMessenger[connectingMessenger.key]?.status === 'connected'}
          renderCredentialsForm={(onSuccess) => {
            const m = connectingMessenger;
            if (m.key === 'telegram') {
              return <TelegramConnectForm onSuccess={onSuccess} />;
            }
            if (m.key === 'slack') {
              return (
                <SlackConnectForm
                  onSubmit={(payload) => {
                    connectMutation.mutate(
                      { messenger: 'slack', payload: payload as never },
                      {
                        onSuccess: () => {
                          toast.success('Slack connected!');
                          onSuccess();
                        },
                        onError: (err) => toast.error(humanizeError(err, 'Failed to connect')),
                      },
                    );
                  }}
                  isPending={connectMutation.isPending}
                />
              );
            }
            if (m.key === 'whatsapp') {
              return <WhatsAppConnectForm onClose={onSuccess} />;
            }
            if (m.key === 'gmail') {
              return (
                <GmailConnectForm
                  onSubmit={(payload) => {
                    connectMutation.mutate(
                      { messenger: 'gmail', payload: payload as never },
                      {
                        onSuccess: () => {
                          toast.success('Gmail connected!');
                          onSuccess();
                        },
                        onError: (err) => toast.error(humanizeError(err, 'Failed to connect')),
                      },
                    );
                  }}
                  isPending={connectMutation.isPending}
                />
              );
            }
            return null;
          }}
          onClose={() => setConnectingMessenger(null)}
        />
      )}

      {/* Settings modal */}
      {settingsMessenger && integrationsByMessenger[settingsMessenger.key] && (
        <IntegrationSettingsModal
          messenger={settingsMessenger}
          integration={integrationsByMessenger[settingsMessenger.key]!}
          onClose={() => setSettingsMessenger(null)}
        />
      )}
    </>
  );
}
