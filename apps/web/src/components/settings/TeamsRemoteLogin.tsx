'use client';

import { useEffect } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, Plug } from 'lucide-react';
import { useTeamsRemoteLogin } from '@/hooks/useTeamsRemoteLogin';

/**
 * Teams login, driven through a remote browser.
 *
 * Microsoft has no OAuth path for personal accounts, and MFA defeats scripted
 * logins — so the server runs a headless browser and we render its screen here.
 * The operator clicks and types into it as if it were their own.
 */
export function TeamsRemoteLogin({ onClose }: { onClose: () => void }) {
  const { status, frameUrl, viewport, error, saving, start, stop, click, keyDown, save } =
    useTeamsRemoteLogin();

  // A successful login closes the modal; the integration list refetches itself.
  useEffect(() => {
    if (status === 'connected') {
      const t = setTimeout(onClose, 1200);
      return () => clearTimeout(t);
    }
  }, [status, onClose]);

  if (status === 'connected') {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <CheckCircle2 className="h-10 w-10 text-emerald-500" />
        <p className="text-sm font-medium text-slate-700">MS Teams connected</p>
        <p className="text-xs text-slate-500">You can now bring in your Teams chats and start broadcasting.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {status === 'idle' && (
        <>
          <div className="flex items-start gap-2 rounded-lg bg-indigo-50 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
            <div className="space-y-1 text-xs text-indigo-700">
              <p>
                Teams has no API login for personal accounts, so we open a browser on the
                server and show it to you here. Sign in exactly as you normally would,
                including two-factor codes.
              </p>
              <p className="text-indigo-600">
                When your chat list appears, press <strong>Save session</strong>.
              </p>
            </div>
          </div>
          <button
            onClick={start}
            className="flex w-full items-center justify-center gap-2 rounded bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px"
          >
            <Plug className="h-4 w-4" />
            Open Teams login
          </button>
        </>
      )}

      {status === 'starting' && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
          <p className="text-sm text-slate-600">Opening a browser for you…</p>
        </div>
      )}

      {status === 'streaming' && (
        <div className="space-y-3">
          {/*
            The wrapper is focusable so it can receive keystrokes, and holds a fixed
            16:9 box so the dialog does not jump when the first frame arrives.
            `max-h` keeps the frame inside the viewport on short screens.
          */}
          <div
            tabIndex={0}
            onKeyDown={keyDown}
            className="relative aspect-video max-h-[70vh] w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-900 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
          >
            {frameUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={frameUrl}
                alt="Teams login"
                onClick={click}
                className="h-full w-full cursor-pointer select-none object-contain"
                draggable={false}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-7 w-7 animate-spin text-slate-500" />
              </div>
            )}
          </div>

          <p className="text-center text-xs text-slate-500">
            Click the picture and type as usual. We\u2019ll save everything once your chats appear.
          </p>

          <div className="mx-auto flex max-w-md gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="flex flex-1 items-center justify-center gap-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save session
            </button>
            <button
              onClick={() => void stop()}
              className="rounded border border-slate-200 px-4 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-center gap-3 py-6">
          <AlertCircle className="h-8 w-8 text-rose-500" />
          <p className="text-center text-sm text-slate-600">{error}</p>
          <button
            onClick={start}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Try again
          </button>
        </div>
      )}

      {/* A failed save leaves us streaming; surface why without losing the frame. */}
      {status === 'streaming' && error && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-700">{error}</p>
        </div>
      )}
    </div>
  );
}
