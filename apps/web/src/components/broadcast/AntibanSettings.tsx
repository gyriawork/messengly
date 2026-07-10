'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Save,
  RotateCcw,
  Shield,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  useAntibanSettings,
  useUpdateAntiban,
  useRiskScore,
} from '@/hooks/useBroadcasts';
import type { AntibanSettings as AntibanSettingsType } from '@/types/broadcast';
import {
  ANTIBAN_DEFAULTS,
  ANTIBAN_SAFE_PRESETS,
  ANTIBAN_MODERATE_PRESETS,
} from '@/types/broadcast';

const messengerTabs = [
  { key: 'telegram', label: 'Telegram', bgClass: 'bg-messenger-tg-bg', textClass: 'text-messenger-tg-text' },
  { key: 'slack', label: 'Slack', bgClass: 'bg-messenger-sl-bg', textClass: 'text-messenger-sl-text' },
  { key: 'whatsapp', label: 'WhatsApp', bgClass: 'bg-messenger-wa-bg', textClass: 'text-messenger-wa-text' },
  { key: 'teams', label: 'MS Teams', bgClass: 'bg-messenger-mt-bg', textClass: 'text-messenger-mt-text' },
] as const;

export function AntibanSettings() {
  const [activeMessenger, setActiveMessenger] = useState('telegram');
  const { data } = useAntibanSettings();
  const updateMutation = useUpdateAntiban();

  const serverSettings = useMemo(() => {
    if (!data?.settings) return {};
    const map: Record<string, AntibanSettingsType> = {};
    for (const s of data.settings) {
      map[s.messenger] = s;
    }
    return map;
  }, [data?.settings]);

  const [localSettings, setLocalSettings] =
    useState<Record<string, AntibanSettingsType>>(ANTIBAN_DEFAULTS);

  useEffect(() => {
    if (Object.keys(serverSettings).length > 0) {
      setLocalSettings((prev) => ({ ...prev, ...serverSettings }));
    }
  }, [serverSettings]);

  const current = localSettings[activeMessenger] || ANTIBAN_DEFAULTS[activeMessenger];

  const { data: riskData } = useRiskScore(current);

  const updateField = useCallback(
    (field: keyof AntibanSettingsType, value: number | boolean) => {
      setLocalSettings((prev) => ({
        ...prev,
        [activeMessenger]: {
          ...prev[activeMessenger],
          [field]: value,
        },
      }));
    },
    [activeMessenger],
  );

  function handleSave() {
    updateMutation.mutate(current, {
      onSuccess: () => toast.success('Settings saved'),
      onError: () => toast.error('Failed to save settings'),
    });
  }

  function handleReset() {
    setLocalSettings((prev) => ({
      ...prev,
      [activeMessenger]: ANTIBAN_SAFE_PRESETS[activeMessenger],
    }));
    toast.success('Reset to safe defaults');
  }

  function applyPreset(preset: Record<string, AntibanSettingsType>) {
    const p = preset[activeMessenger];
    if (!p) return;
    setLocalSettings((prev) => ({
      ...prev,
      [activeMessenger]: { ...p, messenger: activeMessenger, id: prev[activeMessenger]?.id },
    }));
  }

  // Compute local risk score if server score is not available
  const riskScore = riskData?.score ?? computeLocalRisk(current);
  const riskZone =
    riskData?.zone ?? getRiskZone(riskScore);
  const riskDescription =
    riskData?.description ?? getRiskDescription(riskZone);

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center gap-2">
        <Shield className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold text-slate-900">
          Broadcast Settings
        </h2>
      </div>

      {/* Messenger tabs */}
      <div className="mb-6 flex gap-1">
        {messengerTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveMessenger(tab.key)}
            className={cn(
              'flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors',
              activeMessenger === tab.key
                ? `${tab.bgClass} ${tab.textClass}`
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Risk Meter */}
      <div className="mb-6 flex flex-col items-center">
        <RiskGauge score={riskScore} zone={riskZone} />
        <p
          className={cn(
            'mt-2 text-sm font-semibold',
            riskZone === 'safe' && 'text-emerald-600',
            riskZone === 'moderate' && 'text-amber-600',
            riskZone === 'risky' && 'text-orange-600',
            riskZone === 'dangerous' && 'text-red-600',
          )}
        >
          {riskZone.charAt(0).toUpperCase() + riskZone.slice(1)} ({riskScore}
          /100)
        </p>
        <p className="mt-0.5 text-center text-xs text-slate-500">
          {riskDescription}
        </p>
      </div>

      {/* Sliders */}
      <div className="space-y-5">
        <SliderControl
          label="Messages per Batch"
          value={current.messagesPerBatch}
          min={1}
          max={100}
          step={1}
          onChange={(v) => updateField('messagesPerBatch', v)}
        />
        <SliderControl
          label="Delay Between Messages"
          value={current.delayBetweenMessages}
          min={0}
          max={30}
          step={0.5}
          unit="sec"
          onChange={(v) => updateField('delayBetweenMessages', v)}
        />
        <SliderControl
          label="Delay Between Batches"
          value={current.delayBetweenBatches}
          min={0}
          max={300}
          step={5}
          unit="sec"
          onChange={(v) => updateField('delayBetweenBatches', v)}
        />
        <SliderControl
          label="Max Messages / Hour"
          value={current.maxMessagesPerHour}
          min={10}
          max={1000}
          step={10}
          onChange={(v) => updateField('maxMessagesPerHour', v)}
        />
        <SliderControl
          label="Max Messages / Day"
          value={current.maxMessagesPerDay}
          min={100}
          max={10000}
          step={100}
          onChange={(v) => updateField('maxMessagesPerDay', v)}
        />

        {/* Auto-retry section */}
        <div className="border-t border-slate-100 pt-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">
              Auto-Retry Failed Messages
            </span>
            <button
              onClick={() =>
                updateField('autoRetryEnabled', !current.autoRetryEnabled)
              }
              className={cn(
                'relative h-5 w-9 rounded-full transition-colors',
                current.autoRetryEnabled ? 'bg-accent' : 'bg-slate-300',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all',
                  current.autoRetryEnabled ? 'left-[18px]' : 'left-0.5',
                )}
              />
            </button>
          </div>
          {current.autoRetryEnabled && (
            <div className="space-y-4 pl-0">
              <SliderControl
                label="Max Retry Attempts"
                value={current.maxRetryAttempts}
                min={1}
                max={10}
                step={1}
                onChange={(v) => updateField('maxRetryAttempts', v)}
              />
              <SliderControl
                label="Retry Window"
                value={current.retryWindowHours}
                min={1}
                max={72}
                step={1}
                unit="hrs"
                onChange={(v) => updateField('retryWindowHours', v)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Info banner */}
      <div className="mt-5 flex items-start gap-2 rounded-lg bg-accent-bg px-3 py-2.5">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p className="text-xs text-slate-600">
          These settings are applied to every broadcast for this messenger. Save to activate.
        </p>
      </div>

      {/* Presets */}
      <div className="mt-4">
        <p className="mb-2 text-xs font-medium text-slate-500 uppercase tracking-wide">Quick Presets</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => applyPreset(ANTIBAN_SAFE_PRESETS)}
            className="flex items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-emerald-200 bg-emerald-50 py-2 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Safe (Recommended)
          </button>
          <button
            type="button"
            onClick={() => applyPreset(ANTIBAN_MODERATE_PRESETS)}
            className="flex items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-amber-200 bg-amber-50 py-2 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Moderate
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-3 flex gap-2">
        <button
          onClick={handleReset}
          className="flex flex-1 items-center justify-center gap-1.5 rounded border-[1.5px] border-slate-200 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </button>
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="flex flex-1 items-center justify-center gap-1.5 rounded bg-accent py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          Save
        </button>
      </div>
    </div>
  );
}

/* ---------- Slider Control ---------- */

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: SliderControlProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm text-slate-600">{label}</span>
        <span className="text-sm font-semibold text-slate-900">
          {value}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="antiban-slider w-full"
          style={
            {
              '--slider-pct': `${pct}%`,
            } as React.CSSProperties
          }
        />
      </div>
      <style jsx>{`
        .antiban-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 6px;
          border-radius: 3px;
          background: linear-gradient(
            to right,
            #6366f1 0%,
            #6366f1 var(--slider-pct),
            #e2e8f0 var(--slider-pct),
            #e2e8f0 100%
          );
          outline: none;
          cursor: pointer;
        }
        .antiban-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: white;
          border: 2px solid #6366f1;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
          cursor: pointer;
          transition: transform 0.15s;
        }
        .antiban-slider::-webkit-slider-thumb:hover {
          transform: scale(1.15);
        }
        .antiban-slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: white;
          border: 2px solid #6366f1;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}

/* ---------- Risk Gauge (SVG semicircle) ---------- */

function RiskGauge({
  score,
  zone,
}: {
  score: number;
  zone: 'safe' | 'moderate' | 'risky' | 'dangerous';
}) {
  const pct = Math.min(Math.max(score, 0), 100);

  const zoneColors: Record<string, string> = {
    safe: '#10b981',
    moderate: '#f59e0b',
    risky: '#f97316',
    dangerous: '#ef4444',
  };

  return (
    <div className="w-full max-w-sm px-1">
      <div className="relative py-2">
        <div className="h-3 w-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-red-500 shadow-inner" />
        {/* Marker slides along the gradient as the sliders change. */}
        <div
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-500 ease-out"
          style={{ left: `${pct}%` }}
        >
          <div
            className="h-6 w-6 rounded-full border-[3px] bg-white shadow-md"
            style={{ borderColor: zoneColors[zone] }}
          />
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[11px] font-medium">
        <span className="text-emerald-600">Safe</span>
        <span className="text-amber-500">Moderate</span>
        <span className="text-red-500">Aggressive</span>
      </div>
    </div>
  );
}

/* ---------- Local risk computation ---------- */

function computeLocalRisk(settings: AntibanSettingsType): number {
  let score = 0;

  // High messages per batch increases risk
  if (settings.messagesPerBatch > 50) score += 25;
  else if (settings.messagesPerBatch > 30) score += 15;
  else if (settings.messagesPerBatch > 15) score += 8;

  // Low delay between messages increases risk
  if (settings.delayBetweenMessages < 1) score += 25;
  else if (settings.delayBetweenMessages < 2) score += 15;
  else if (settings.delayBetweenMessages < 5) score += 5;

  // Low delay between batches increases risk
  if (settings.delayBetweenBatches < 10) score += 20;
  else if (settings.delayBetweenBatches < 30) score += 10;
  else if (settings.delayBetweenBatches < 60) score += 5;

  // High max messages per hour
  if (settings.maxMessagesPerHour > 500) score += 20;
  else if (settings.maxMessagesPerHour > 300) score += 10;
  else if (settings.maxMessagesPerHour > 100) score += 5;

  // High max messages per day
  if (settings.maxMessagesPerDay > 5000) score += 10;
  else if (settings.maxMessagesPerDay > 2000) score += 5;

  return Math.min(score, 100);
}

function getRiskZone(
  score: number,
): 'safe' | 'moderate' | 'risky' | 'dangerous' {
  if (score <= 25) return 'safe';
  if (score <= 50) return 'moderate';
  if (score <= 75) return 'risky';
  return 'dangerous';
}

function getRiskDescription(
  zone: 'safe' | 'moderate' | 'risky' | 'dangerous',
): string {
  const descriptions = {
    safe: 'Low risk of account restrictions. Conservative sending pace.',
    moderate: 'Moderate risk. Consider reducing batch sizes or increasing delays.',
    risky: 'High risk of triggering anti-spam. Reduce sending speed.',
    dangerous: 'Very high ban risk. Strongly reduce volume and increase delays.',
  };
  return descriptions[zone];
}
