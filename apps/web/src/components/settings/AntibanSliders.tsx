'use client';

import { useState, useCallback } from 'react';
import { AlertCircle, AlertTriangle, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AntibanSettings {
  messagesPerBatch: number;
  delayBetweenMessages: number;
  delayBetweenBatches: number;
  maxMessagesPerHour: number;
  maxMessagesPerDay: number;
}

interface AntibanSlidersProps {
  messenger: string;
  initialSettings: AntibanSettings;
  onUpdate: (settings: AntibanSettings) => Promise<void>;
  isLoading?: boolean;
}

type RiskLevel = 'low' | 'medium' | 'high';

export function AntibanSliders({
  messenger,
  initialSettings,
  onUpdate,
  isLoading = false,
}: AntibanSlidersProps) {
  const [settings, setSettings] = useState<AntibanSettings>(initialSettings);
  const [isSaving, setIsSaving] = useState(false);

  // Calculate risk level based on settings
  const calculateRisk = useCallback(
    (config: AntibanSettings): RiskLevel => {
      // Risk scoring: higher throughput = higher risk
      const dailyRate = config.maxMessagesPerDay;
      const hourlyRate = config.maxMessagesPerHour;
      const delayScore = config.delayBetweenMessages + config.delayBetweenBatches;

      // Low risk: conservative settings (low throughput, high delays)
      if (dailyRate <= 1000 && hourlyRate <= 100 && delayScore >= 15) {
        return 'low';
      }
      // High risk: aggressive settings (high throughput, low delays)
      if (dailyRate >= 3000 || hourlyRate >= 300 || delayScore < 5) {
        return 'high';
      }
      // Medium risk: moderate settings
      return 'medium';
    },
    [],
  );

  const riskLevel = calculateRisk(settings);

  const riskConfig: Record<
    RiskLevel,
    { color: string; bgColor: string; icon: React.ReactNode; label: string }
  > = {
    low: {
      color: 'text-green-700',
      bgColor: 'bg-green-50 border-green-200',
      icon: <AlertCircle className="h-4 w-4" />,
      label: 'Low Risk - Safe & Stable',
    },
    medium: {
      color: 'text-yellow-700',
      bgColor: 'bg-yellow-50 border-yellow-200',
      icon: <AlertTriangle className="h-4 w-4" />,
      label: 'Medium Risk - Moderate Speed',
    },
    high: {
      color: 'text-red-700',
      bgColor: 'bg-red-50 border-red-200',
      icon: <Zap className="h-4 w-4" />,
      label: 'High Risk - Aggressive',
    },
  };

  const risk = riskConfig[riskLevel];

  const handleSliderChange = (
    key: keyof AntibanSettings,
    value: number,
  ) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onUpdate(settings);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 rounded-lg border border-slate-200 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Antiban Settings - {messenger}
        </h3>
      </div>

      {/* Risk Meter */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase text-slate-400">
            Risk Level
          </p>
        </div>

        {/* Risk bar */}
        <div className="flex h-3 gap-1 rounded-full overflow-hidden bg-slate-100">
          <div
            className={cn(
              'flex-1 transition-colors',
              riskLevel === 'low'
                ? 'bg-green-400'
                : riskLevel === 'medium'
                  ? 'bg-slate-300'
                  : 'bg-slate-200',
            )}
          />
          <div
            className={cn(
              'flex-1 transition-colors',
              riskLevel === 'medium' || riskLevel === 'high'
                ? riskLevel === 'medium'
                  ? 'bg-yellow-400'
                  : 'bg-slate-300'
                : 'bg-slate-200',
            )}
          />
          <div
            className={cn(
              'flex-1 transition-colors',
              riskLevel === 'high' ? 'bg-red-400' : 'bg-slate-200',
            )}
          />
        </div>

        {/* Risk label */}
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
            risk.bgColor,
          )}
        >
          <span className={risk.color}>{risk.icon}</span>
          <span className={cn('font-medium', risk.color)}>{risk.label}</span>
        </div>
      </div>

      {/* Sliders */}
      <div className="space-y-5">
        {/* Messages Per Batch */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-700">
              Messages Per Batch
            </label>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-900">
              {settings.messagesPerBatch}
            </span>
          </div>
          <input
            type="range"
            min="1"
            max="50"
            value={settings.messagesPerBatch}
            onChange={(e) =>
              handleSliderChange('messagesPerBatch', parseInt(e.target.value))
            }
            className="w-full"
          />
          <p className="mt-1 text-xs text-slate-400">
            How many messages to send in each batch (1-50)
          </p>
        </div>

        {/* Delay Between Messages */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-700">
              Delay Between Messages
            </label>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-900">
              {settings.delayBetweenMessages}s
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="60"
            value={settings.delayBetweenMessages}
            onChange={(e) =>
              handleSliderChange('delayBetweenMessages', parseInt(e.target.value))
            }
            className="w-full"
          />
          <p className="mt-1 text-xs text-slate-400">
            Pause between individual messages (0-60 seconds)
          </p>
        </div>

        {/* Delay Between Batches */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-700">
              Delay Between Batches
            </label>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-900">
              {settings.delayBetweenBatches}s
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="600"
            step="5"
            value={settings.delayBetweenBatches}
            onChange={(e) =>
              handleSliderChange('delayBetweenBatches', parseInt(e.target.value))
            }
            className="w-full"
          />
          <p className="mt-1 text-xs text-slate-400">
            Pause between batches (0-600 seconds / 0-10 minutes)
          </p>
        </div>

        {/* Max Messages Per Hour */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-700">
              Max Messages Per Hour
            </label>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-900">
              {settings.maxMessagesPerHour}
            </span>
          </div>
          <input
            type="range"
            min="1"
            max="500"
            value={settings.maxMessagesPerHour}
            onChange={(e) =>
              handleSliderChange('maxMessagesPerHour', parseInt(e.target.value))
            }
            className="w-full"
          />
          <p className="mt-1 text-xs text-slate-400">
            Rate limit per hour (1-500 messages)
          </p>
        </div>

        {/* Max Messages Per Day */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-700">
              Max Messages Per Day
            </label>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-900">
              {settings.maxMessagesPerDay}
            </span>
          </div>
          <input
            type="range"
            min="1"
            max="5000"
            step="100"
            value={settings.maxMessagesPerDay}
            onChange={(e) =>
              handleSliderChange('maxMessagesPerDay', parseInt(e.target.value))
            }
            className="w-full"
          />
          <p className="mt-1 text-xs text-slate-400">
            Rate limit per day (1-5000 messages)
          </p>
        </div>
      </div>

      {/* Recommendations */}
      <div className="rounded-lg bg-slate-50 p-3">
        <p className="text-xs text-slate-700">
          {riskLevel === 'low' && (
            <>
              <span className="font-medium">✓ Safe Settings:</span> Your
              configuration is conservative and safe. Best for avoiding
              account restrictions.
            </>
          )}
          {riskLevel === 'medium' && (
            <>
              <span className="font-medium">⚠ Moderate Speed:</span> Good
              balance between speed and safety. Monitor account health
              regularly.
            </>
          )}
          {riskLevel === 'high' && (
            <>
              <span className="font-medium">⚡ Aggressive:</span> Fast
              delivery but higher risk of rate limiting. Use caution and
              monitor closely.
            </>
          )}
        </p>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={isSaving || isLoading}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
