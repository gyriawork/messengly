'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';

/**
 * Drives the Teams login flow.
 *
 * Microsoft offers no OAuth for personal accounts, and MFA / passwordless email
 * codes defeat any scripted login. So the teams-agent sidecar runs a headless
 * browser on the server and we turn it into a remote desktop: it streams JPEG
 * frames, we send clicks and keystrokes back, and a human signs in.
 *
 * The agent watches for a confirmed login on every frame and saves the session
 * itself; it tells us through the `X-Logged-In` response header.
 */

const POLL_INTERVAL_MS = 300;

/**
 * Playwright throws transient errors while Microsoft bounces the page through its
 * login redirect chain — a protocol glitch mid-navigation is not a dead session.
 * meetsbroadcast rides these out instead of killing a login that is going fine.
 */
const MAX_CONSECUTIVE_ERRORS = 10;
const ERROR_BACKOFF_MS = 500;

/**
 * Typed characters are batched instead of sent one request per keystroke. A
 * password typed at speed would otherwise fire dozens of requests and, together
 * with the screenshot poll, walk straight into the API's rate limiter.
 */
const TYPE_FLUSH_MS = 150;
const TYPE_FLUSH_MAX_CHARS = 100;

/** The agent only accepts these non-printable keys. */
const ALLOWED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export type TeamsLoginStatus = 'idle' | 'starting' | 'streaming' | 'connected' | 'error';

interface RemoteStartResponse {
  started: boolean;
  viewport: { width: number; height: number };
}

export function useTeamsRemoteLogin() {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<TeamsLoginStatus>('idle');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 1600, height: 900 });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectUrl = useRef<string | null>(null);
  const stopped = useRef(false);

  const typeBuffer = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consecutiveErrors = useRef(0);

  /** Object URLs leak until revoked, and we mint one per frame. */
  const showFrame = useCallback((blob: Blob) => {
    const next = URL.createObjectURL(blob);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = next;
    setFrameUrl(next);
  }, []);

  const finish = useCallback(() => {
    setStatus('connected');
    queryClient.invalidateQueries({ queryKey: ['integrations'] });
  }, [queryClient]);

  const poll = useCallback(async () => {
    if (stopped.current) return;
    try {
      // The timestamp defeats heuristic caching of error responses, which would
      // otherwise poison the loop. Successful frames already say no-store.
      const { blob, headers } = await api.getBinary(
        `/api/integrations/teams/remote/screenshot?t=${Date.now()}`,
      );
      if (stopped.current) return;

      consecutiveErrors.current = 0;
      showFrame(blob);

      if (headers.get('X-Logged-In') === 'true') {
        finish();
        return; // stop polling: the agent already saved the session
      }
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err) {
      if (stopped.current) return;

      // The agent says there is no remote browser any more. That is an ending,
      // not a failure — somebody stopped it, or it timed out on inactivity.
      if (err instanceof ApiError && err.statusCode === 409) {
        stopped.current = true;
        setFrameUrl(null);
        setStatus('idle');
        return;
      }

      consecutiveErrors.current += 1;
      if (consecutiveErrors.current >= MAX_CONSECUTIVE_ERRORS) {
        setError(err instanceof Error ? err.message : 'Lost the remote browser');
        setStatus('error');
        return;
      }
      pollTimer.current = setTimeout(poll, ERROR_BACKOFF_MS);
    }
  }, [showFrame, finish]);

  const start = useCallback(async (forUserId?: string) => {
    setError(null);
    setStatus('starting');
    stopped.current = false;
    consecutiveErrors.current = 0;

    const startOnce = () =>
      api.post<RemoteStartResponse>(
        '/api/integrations/teams/remote/start',
        forUserId ? { forUserId } : {},
      );

    try {
      // Do NOT force-stop an "already active" browser and retry — that used to
      // hijack another operator's live login (they'd see each other's Microsoft
      // screen). The agent now self-reclaims the SAME operator's orphaned login
      // and rejects a DIFFERENT operator with a friendly REMOTE_LOGIN_BUSY (B2).
      const res = await startOnce();
      setViewport(res.viewport);
      setStatus('streaming');
      void poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the remote browser');
      setStatus('error');
    }
  }, [poll]);

  const stop = useCallback(async () => {
    stopped.current = true;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    typeBuffer.current = '';
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    setFrameUrl(null);
    setStatus('idle');
    try {
      await api.post('/api/integrations/teams/remote/stop');
    } catch { /* the browser may already be gone — nothing to do */ }
  }, []);

  /** Send whatever characters have piled up since the last flush. */
  const flushTyping = useCallback(async () => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const text = typeBuffer.current;
    typeBuffer.current = '';
    if (!text) return;

    try {
      await api.post('/api/integrations/teams/remote/type', { text });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Typing failed');
    }
  }, []);

  /**
   * Map a click on the rendered image back to browser viewport coordinates.
   *
   * The image is drawn with `object-contain`, so when the element's box is not
   * exactly 16:9 the picture is letterboxed inside it. Measuring against the
   * element rect alone would then send the wrong coordinates — off by the size of
   * the bars. Compute the drawn area and translate against that.
   */
  const click = useCallback(
    async (event: React.MouseEvent<HTMLImageElement>) => {
      // Read the geometry synchronously. React clears `currentTarget` as soon as
      // the handler returns, and an `await` hands control back before that — so
      // touching it afterwards throws on null and swallows the click.
      const rect = event.currentTarget.getBoundingClientRect();
      const { clientX, clientY } = event;

      const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
      if (!Number.isFinite(scale) || scale <= 0) return;

      const drawnWidth = viewport.width * scale;
      const drawnHeight = viewport.height * scale;
      const offsetX = (rect.width - drawnWidth) / 2;
      const offsetY = (rect.height - drawnHeight) / 2;

      const x = Math.round((clientX - rect.left - offsetX) / scale);
      const y = Math.round((clientY - rect.top - offsetY) / scale);

      // A click on the letterbox bars is outside the browser — the agent would
      // reject it with OUT_OF_BOUNDS, so don't bother it.
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return;

      // Buffered characters belong to the field that is focused right now, not to
      // whatever this click is about to focus — so they must go out first.
      await flushTyping();

      try {
        await api.post('/api/integrations/teams/remote/click', { x, y });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Click failed');
      }
    },
    [viewport, flushTyping],
  );

  const keyDown = useCallback(
    async (event: React.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();

      // Read the event synchronously, before any await — see the note in `click`.
      const key = event.key;

      // Printable characters accumulate and go out as one request.
      if (key.length === 1) {
        typeBuffer.current += key;
        if (typeBuffer.current.length >= TYPE_FLUSH_MAX_CHARS) {
          await flushTyping();
          return;
        }
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(() => void flushTyping(), TYPE_FLUSH_MS);
        return;
      }

      if (!ALLOWED_KEYS.has(key)) return;

      // Order matters: an Enter that overtakes the buffered text would submit an
      // empty field.
      await flushTyping();
      try {
        await api.post('/api/integrations/teams/remote/key', { key });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Key press failed');
      }
    },
    [flushTyping],
  );

  /**
   * Manual save. The agent refuses unless the chat list actually rendered, so a
   * signed-out page can never be stored as a working session.
   */
  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/integrations/teams/remote/save');
      stopped.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the session');
    } finally {
      setSaving(false);
    }
  }, [finish]);

  // Tear the remote browser down if the operator closes the modal mid-login.
  // The agent would eventually reap it after 10 idle minutes, but leaving a
  // headless Chromium alive that long wastes memory on a single-browser service.
  // `connected` is exempt: the agent already stopped it when the session saved.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    return () => {
      const wasStreaming = statusRef.current === 'streaming' || statusRef.current === 'starting';
      stopped.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      if (wasStreaming) {
        // Fire and forget: the component is already gone, nobody can act on a failure.
        void api.post('/api/integrations/teams/remote/stop').catch(() => {});
      }
    };
  }, []);

  return { status, frameUrl, viewport, error, saving, start, stop, click, keyDown, save };
}
