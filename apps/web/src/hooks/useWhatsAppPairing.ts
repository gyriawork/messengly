'use client';

import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── API response types ───

interface PairingStartResponse {
  sessionName?: string;
  qr?: string;
  mimetype?: string;
}

interface PairingStatusResponse {
  status: string;
  qr?: string;
  mimetype?: string;
  message?: string;
}

interface ListChatsResponse {
  chats: WhatsAppChat[];
}

export type WhatsAppPairingStatus =
  | 'idle'
  | 'starting'
  | 'waiting_for_qr'
  | 'qr_ready'
  | 'connecting'
  | 'connected'
  | 'fetching_chats'
  | 'chats_ready'
  | 'importing'
  | 'error';

export interface WhatsAppChat {
  externalChatId: string;
  name: string;
  chatType: string;
}

export function useWhatsAppPairing() {
  const [status, setStatus] = useState<WhatsAppPairingStatus>('idle');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [availableChats, setAvailableChats] = useState<WhatsAppChat[]>([]);
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionNameRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback((sessionName: string, forUserId?: string) => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      try {
        const qs = new URLSearchParams({ sessionName, ...(forUserId ? { forUserId } : {}) });
        const data = await api.get<PairingStatusResponse>(`/api/integrations/whatsapp/pairing-status?${qs}`);

        if (data.status === 'connected' || data.status === 'WORKING') {
          stopPolling();
          setStatus('connected');
          setStatusMessage('WhatsApp connected successfully!');
          setQrDataUrl(null);
          queryClient.invalidateQueries({ queryKey: ['integrations'] });
        } else if (data.status === 'SCAN_QR_CODE' && data.qr) {
          setQrDataUrl(`data:${data.mimetype || 'image/png'};base64,${data.qr}`);
          setStatus('qr_ready');
          setStatusMessage('Scan the QR code with WhatsApp on your phone');
        } else if (data.status === 'failed' || data.status === 'FAILED') {
          stopPolling();
          setError(data.message || 'WhatsApp pairing failed');
          setStatus('error');
          setQrDataUrl(null);
        }
      } catch {
        // Silently retry on next interval; network blips are transient
      }
    }, 3000);
  }, [stopPolling, queryClient]);

  const startPairing = useCallback(async (forUserId?: string) => {
    setStatus('starting');
    setError(null);
    setQrDataUrl(null);
    setStatusMessage('Starting WhatsApp pairing...');

    try {
      const data = await api.post<PairingStartResponse>(
        '/api/integrations/whatsapp/start-pairing',
        forUserId ? { forUserId } : {},
      );

      sessionNameRef.current = data.sessionName ?? null;

      if (data.qr) {
        setQrDataUrl(`data:${data.mimetype || 'image/png'};base64,${data.qr}`);
        setStatus('qr_ready');
        setStatusMessage('Scan the QR code with WhatsApp on your phone');
      } else {
        setStatus('waiting_for_qr');
        setStatusMessage('Generating QR code...');
      }

      if (data.sessionName) {
        startPolling(data.sessionName, forUserId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start WhatsApp pairing';
      setError(message);
      setStatus('error');
    }
  }, [startPolling]);

  const cancelPairing = useCallback(() => {
    stopPolling();
    const sessionName = sessionNameRef.current;
    sessionNameRef.current = null;
    setStatus('idle');
    setQrDataUrl(null);
    setStatusMessage('');
    setError(null);

    if (sessionName) {
      api.post('/api/integrations/whatsapp/cancel-pairing', { sessionName }).catch(() => {});
    }
  }, [stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    sessionNameRef.current = null;
    setStatus('idle');
    setQrDataUrl(null);
    setStatusMessage('');
    setError(null);
    setAvailableChats([]);
    setSelectedChatIds(new Set());
  }, [stopPolling]);

  const listChats = useCallback(async () => {
    setStatus('fetching_chats');
    setStatusMessage('Fetching available chats...');

    try {
      const data = await api.post<ListChatsResponse>('/api/integrations/whatsapp/list-chats', {});
      const chats: WhatsAppChat[] = data.chats ?? [];
      setAvailableChats(chats);
      setStatus('chats_ready');
      setStatusMessage(`Found ${chats.length} chats. Select chats to import.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch chats';
      setError(message);
      setStatus('error');
    }
  }, []);

  const toggleChatSelection = useCallback((chatId: string) => {
    setSelectedChatIds((prev) => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  }, []);

  const importSelectedChats = useCallback(async () => {
    if (selectedChatIds.size === 0) {
      setError('Please select at least one chat');
      return;
    }

    setStatus('importing');
    setStatusMessage(`Importing ${selectedChatIds.size} chat(s)...`);

    try {
      await api.post('/api/chats/import', {
        messenger: 'whatsapp',
        externalChatIds: Array.from(selectedChatIds),
      });

      setStatusMessage('Chats imported successfully!');
      setStatus('idle');
      setAvailableChats([]);
      setSelectedChatIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import chats';
      setError(message);
      setStatus('error');
    }
  }, [selectedChatIds, queryClient]);

  return {
    status,
    qrDataUrl,
    statusMessage,
    error,
    availableChats,
    selectedChatIds,
    startPairing,
    cancelPairing,
    reset,
    listChats,
    toggleChatSelection,
    importSelectedChats,
  };
}
