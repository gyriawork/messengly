'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

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

const POLL_INTERVAL_MS = 700;

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
      const { blob, headers } = await api.getBinary('/api/integrations/teams/remote/screenshot');
      if (stopped.current) return;

      showFrame(blob);

      if (headers.get('X-Logged-In') === 'true') {
        finish();
        return; // stop polling: the agent already saved the session
      }
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err) {
      if (stopped.current) return;
      setError(err instanceof Error ? err.message : 'Lost the remote browser');
      setStatus('error');
    }
  }, [showFrame, finish]);

  const start = useCallback(async () => {
    setError(null);
    setStatus('starting');
    stopped.current = false;
    try {
      const res = await api.post<RemoteStartResponse>('/api/integrations/teams/remote/start');
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
      const rect = event.currentTarget.getBoundingClientRect();
      const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
      if (!Number.isFinite(scale) || scale <= 0) return;

      const drawnWidth = viewport.width * scale;
      const drawnHeight = viewport.height * scale;
      const offsetX = (rect.width - drawnWidth) / 2;
      const offsetY = (rect.height - drawnHeight) / 2;

      const x = Math.round((event.clientX - rect.left - offsetX) / scale);
      const y = Math.round((event.clientY - rect.top - offsetY) / scale);

      // A click on the letterbox bars is outside the browser — the agent would
      // reject it with OUT_OF_BOUNDS, so don't bother it.
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return;

      try {
        await api.post('/api/integrations/teams/remote/click', { x, y });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Click failed');
      }
    },
    [viewport],
  );

  /** The agent only accepts a small allowlist of non-printable keys. */
  const ALLOWED_KEYS = new Set([
    'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ]);

  const keyDown = useCallback(async (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();

    try {
      if (event.key.length === 1) {
        await api.post('/api/integrations/teams/remote/type', { text: event.key });
      } else if (ALLOWED_KEYS.has(event.key)) {
        await api.post('/api/integrations/teams/remote/key', { key: event.key });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Key press failed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      if (wasStreaming) {
        // Fire and forget: the component is already gone, nobody can act on a failure.
        void api.post('/api/integrations/teams/remote/stop').catch(() => {});
      }
    };
  }, []);

  return { status, frameUrl, viewport, error, saving, start, stop, click, keyDown, save };
}
