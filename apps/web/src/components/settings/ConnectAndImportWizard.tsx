'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  Loader2,
  CheckCircle2,
  Search,
  ArrowRight,
  ArrowLeft,
  Download,
  MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { getSocket } from '@/hooks/useSocket';
import { useQueryClient } from '@tanstack/react-query';
import type { MessengerType } from '@/types/integration';

// ─── Types ───

interface ExternalChat {
  externalChatId: string;
  name: string;
  chatType: string;
}

interface ImportProgress {
  done: number;
  total: number;
  currentName: string;
}

type WizardStep = 'credentials' | 'loading-chats' | 'selecting' | 'importing' | 'done' | 'error';

interface ConnectAndImportWizardProps {
  messenger: MessengerType;
  messengerName: string;
  isAlreadyConnected?: boolean;
  /** Render prop: receives onSuccess callback to call when credentials are verified */
  renderCredentialsForm?: (onSuccess: () => void) => React.ReactNode;
  onClose: () => void;
}

// ─── Chat Selector ───

function ChatSelector({
  chats,
  selected,
  onToggle,
  onSelectAll,
  onDeselectAll,
}: {
  chats: ExternalChat[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}) {
  const [search, setSearch] = useState('');

  const filtered = search
    ? chats.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : chats;

  const typeOrder: Record<string, number> = { channel: 0, group: 1, direct: 2 };
  const sorted = [...filtered].sort(
    (a, b) => (typeOrder[a.chatType] ?? 3) - (typeOrder[b.chatType] ?? 3),
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Search + Select controls */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-slate-400 focus:border-accent focus:bg-white"
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">
          Selected: <span className="font-semibold text-slate-700">{selected.size}</span> of {chats.length}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-xs font-medium text-accent hover:underline"
          >
            Select all
          </button>
          <span className="text-xs text-slate-300">|</span>
          <button
            type="button"
            onClick={onDeselectAll}
            className="text-xs font-medium text-slate-500 hover:underline"
          >
            Deselect all
          </button>
        </div>
      </div>

      {/* Chat list */}
      <div className="max-h-[340px] overflow-y-auto rounded-lg border border-slate-200">
        {sorted.length === 0 && (
          <p className="p-4 text-center text-sm text-slate-400">No chats found</p>
        )}
        {sorted.map((chat) => {
          const isSelected = selected.has(chat.externalChatId);
          return (
            <label
              key={chat.externalChatId}
              className={cn(
                'flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2.5 transition-colors last:border-b-0 hover:bg-slate-50',
                isSelected && 'bg-accent/5',
              )}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(chat.externalChatId)}
                className="h-4 w-4 rounded border-slate-300 text-accent accent-accent"
              />
              <div className="flex flex-1 items-center gap-2 overflow-hidden">
                <MessageSquare className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="truncate text-sm text-slate-700">{chat.name}</span>
              </div>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                {chat.chatType}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ─── Import Progress ───

function ImportProgressView({
  progress,
  messenger,
}: {
  progress: ImportProgress;
  messenger: MessengerType;
}) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <MessengerIcon messenger={messenger} size={48} />
      <div className="w-full space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">
            Importing <span className="font-semibold">{progress.done}</span> of{' '}
            <span className="font-semibold">{progress.total}</span>...
          </span>
          <span className="font-medium text-accent">{pct}%</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        {progress.currentName && (
          <p className="text-center text-xs text-slate-500">
            Loading messages from <span className="font-medium">{progress.currentName}</span>
          </p>
        )}
      </div>
      <Loader2 className="h-5 w-5 animate-spin text-accent" />
    </div>
  );
}

// ─── Main Wizard ───

export function ConnectAndImportWizard({
  messenger,
  messengerName,
  isAlreadyConnected = false,
  renderCredentialsForm,
  onClose,
}: ConnectAndImportWizardProps) {
  const [step, setStep] = useState<WizardStep>(
    isAlreadyConnected ? 'loading-chats' : 'credentials',
  );
  const [chats, setChats] = useState<ExternalChat[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ImportProgress>({ done: 0, total: 0, currentName: '' });
  const [importResult, setImportResult] = useState<{ imported: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const importingRef = useRef(false);

  // ── Load chat list ──
  const loadChats = useCallback(async () => {
    setStep('loading-chats');
    setError(null);
    try {
      const data = await api.post<{ chats: ExternalChat[] }>(
        `/api/integrations/${messenger}/list-chats`,
        {},
      );
      setChats(data.chats);
      // Pre-select all by default
      setSelected(new Set(data.chats.map((c) => c.externalChatId)));
      setStep('selecting');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chats');
      setStep('error');
    }
  }, [messenger]);

  // When already connected, load chats immediately
  useEffect(() => {
    if (isAlreadyConnected && step === 'loading-chats') {
      loadChats();
    }
  }, [isAlreadyConnected, step, loadChats]);

  // ── Credentials step completed → transition to loading ──
  const handleCredentialsSuccess = useCallback(() => {
    loadChats();
  }, [loadChats]);

  // ── WebSocket listeners for import progress ──
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleProgress = (data: ImportProgress) => {
      if (importingRef.current) {
        setProgress(data);
      }
    };

    const handleComplete = (data: { imported: number; failed: number }) => {
      if (importingRef.current) {
        importingRef.current = false;
        setImportResult(data);
        setStep('done');
        queryClient.invalidateQueries({ queryKey: ['chats'] });
      }
    };

    socket.on('import_chat_progress', handleProgress);
    socket.on('import_chat_complete', handleComplete);

    return () => {
      socket.off('import_chat_progress', handleProgress);
      socket.off('import_chat_complete', handleComplete);
    };
  }, [queryClient]);

  // ── Start import ──
  const handleImport = useCallback(async () => {
    if (selected.size === 0) return;

    const selectedChats = chats
      .filter((c) => selected.has(c.externalChatId))
      .map((c) => ({
        externalChatId: c.externalChatId,
        name: c.name,
        chatType: c.chatType as 'direct' | 'group' | 'channel',
      }));

    setStep('importing');
    setProgress({ done: 0, total: selectedChats.length, currentName: '' });
    importingRef.current = true;

    try {
      const result = await api.post<{ imported: unknown[]; count: number; failed: number }>(
        '/api/chats/import-with-history',
        { messenger, chats: selectedChats },
      );
      // HTTP response also carries the result — use it if WS didn't fire
      if (importingRef.current) {
        importingRef.current = false;
        setImportResult({ imported: result.count, failed: result.failed });
        setStep('done');
        queryClient.invalidateQueries({ queryKey: ['chats'] });
      }
    } catch (err) {
      importingRef.current = false;
      setError(err instanceof Error ? err.message : 'Import failed');
      setStep('error');
    }
  }, [selected, chats, messenger, queryClient]);

  // ── Selection helpers ──
  const toggleChat = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(chats.map((c) => c.externalChatId)));
  const deselectAll = () => setSelected(new Set());

  // ── Render ──
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center">
      <div className="w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-lg md:max-w-lg md:rounded-xl">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MessengerIcon messenger={messenger} size={40} />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                {step === 'credentials' && `Connect ${messengerName}`}
                {step === 'loading-chats' && `Loading chats...`}
                {step === 'selecting' && `Select chats to import`}
                {step === 'importing' && `Importing chats...`}
                {step === 'done' && `Import complete`}
                {step === 'error' && `Something went wrong`}
              </h3>
              <p className="text-xs text-slate-500">
                {step === 'credentials' && 'Enter your credentials to get started'}
                {step === 'loading-chats' && `Fetching available ${messengerName} chats`}
                {step === 'selecting' && 'Choose which chats to import with message history'}
                {step === 'importing' && 'Loading messages from selected chats'}
                {step === 'done' && 'Your chats are ready'}
                {step === 'error' && 'Please try again'}
              </p>
            </div>
          </div>
          {step !== 'importing' && (
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Step indicator */}
        {step !== 'error' && (
          <div className="mb-5 flex items-center gap-2">
            {['credentials', 'selecting', 'importing'].map((s, i) => {
              const stepNames = ['Connect', 'Select Chats', 'Import'];
              const stepKeys = ['credentials', 'selecting', 'importing'];
              const currentIdx = stepKeys.indexOf(
                step === 'loading-chats' ? 'selecting' : step === 'done' ? 'importing' : step,
              );
              const isActive = i <= currentIdx;
              const isCurrent = i === currentIdx;
              return (
                <div key={s} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className={cn(
                      'h-1.5 w-full rounded-full transition-colors',
                      isActive ? 'bg-accent' : 'bg-slate-100',
                      isCurrent && step !== 'done' && 'bg-accent/60',
                    )}
                  />
                  <span className={cn(
                    'text-[10px] font-medium',
                    isActive ? 'text-accent' : 'text-slate-400',
                  )}>
                    {stepNames[i]}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Step: Credentials ── */}
        {step === 'credentials' && renderCredentialsForm?.(handleCredentialsSuccess)}

        {/* ── Step: Loading chats ── */}
        {step === 'loading-chats' && (
          <div className="flex flex-col items-center gap-3 py-10">
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
            <p className="text-sm text-slate-600">Loading {messengerName} chats...</p>
          </div>
        )}

        {/* ── Step: Selecting ── */}
        {step === 'selecting' && (
          <>
            <ChatSelector
              chats={chats}
              selected={selected}
              onToggle={toggleChat}
              onSelectAll={selectAll}
              onDeselectAll={deselectAll}
            />
            <div className="mt-4 flex gap-2">
              {!isAlreadyConnected && (
                <button
                  onClick={() => setStep('credentials')}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </button>
              )}
              <button
                onClick={onClose}
                className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
              >
                Skip
              </button>
              <button
                onClick={handleImport}
                disabled={selected.size === 0}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                Import selected ({selected.size})
              </button>
            </div>
          </>
        )}

        {/* ── Step: Importing ── */}
        {step === 'importing' && (
          <ImportProgressView progress={progress} messenger={messenger} />
        )}

        {/* ── Step: Done ── */}
        {step === 'done' && importResult && (
          <div className="flex flex-col items-center gap-4 py-6">
            <CheckCircle2 className="h-14 w-14 text-emerald-500" />
            <div className="text-center">
              <p className="text-lg font-semibold text-slate-900">
                {importResult.imported} {importResult.imported === 1 ? 'chat' : 'chats'} imported!
              </p>
              {importResult.failed > 0 && (
                <p className="mt-1 text-sm text-amber-600">
                  {importResult.failed} {importResult.failed === 1 ? 'chat' : 'chats'} failed to import.
                </p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                Messages have been loaded and chats are ready to use.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
              >
                Close
              </button>
              <button
                onClick={() => {
                  onClose();
                  window.location.href = '/chats';
                }}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px"
              >
                Go to Messenger
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Error ── */}
        {step === 'error' && (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="rounded-full bg-red-50 p-3">
              <X className="h-8 w-8 text-red-500" />
            </div>
            <p className="text-center text-sm text-red-700">{error}</p>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
              >
                Close
              </button>
              <button
                onClick={loadChats}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover"
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
