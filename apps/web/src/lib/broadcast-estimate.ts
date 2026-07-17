/**
 * Broadcast duration estimate — mirrors the worker's send loop exactly
 * (apps/worker/src/index.ts sendMessengerBatch): inter-message delay within a
 * batch, a pause at every batch boundary, a 60s cooldown when the hourly cap
 * is hit, and a hard stop at the daily cap (the remainder goes out on retry).
 * Messengers send in PARALLEL, so the whole broadcast finishes with the
 * slowest one.
 */

export interface AntibanPacing {
  messagesPerBatch: number;
  delayBetweenMessages: number;
  delayBetweenBatches: number;
  maxMessagesPerHour: number;
  maxMessagesPerDay: number;
}

export interface MessengerEstimate {
  seconds: number;
  /** Chats that fit under the daily cap (the rest retry the next day). */
  sentToday: number;
  /** True when the daily cap cuts the run short. */
  dailyCapHit: boolean;
}

// How long one actual send takes, roughly, per messenger. Teams drives a real
// browser (find chat → type → verify), the rest are API calls.
const PER_SEND_SECONDS: Record<string, number> = {
  teams: 10,
  whatsapp: 2,
  gmail: 2,
  telegram: 1.5,
  slack: 1,
};

const DEFAULT_PACING: AntibanPacing = {
  messagesPerBatch: 10,
  delayBetweenMessages: 5,
  delayBetweenBatches: 60,
  maxMessagesPerHour: 100,
  maxMessagesPerDay: 500,
};

export function estimateMessenger(
  messenger: string,
  chatCount: number,
  pacing?: Partial<AntibanPacing> | null,
): MessengerEstimate {
  const cfg = { ...DEFAULT_PACING, ...(pacing ?? {}) };
  const perSend = PER_SEND_SECONDS[messenger] ?? 2;

  let seconds = 0;
  let batch = 0;
  let hourly = 0;
  let daily = 0;
  let sentToday = 0;

  for (let i = 0; i < chatCount; i++) {
    if (hourly >= cfg.maxMessagesPerHour) {
      seconds += 60;
      hourly = 0;
    }
    if (daily >= cfg.maxMessagesPerDay) break;
    if (batch >= cfg.messagesPerBatch && batch > 0) {
      seconds += cfg.delayBetweenBatches;
      batch = 0;
    }
    if (batch > 0) seconds += cfg.delayBetweenMessages;
    seconds += perSend;
    batch++;
    hourly++;
    daily++;
    sentToday++;
  }

  return {
    seconds: Math.round(seconds),
    sentToday,
    dailyCapHit: sentToday < chatCount,
  };
}

/** `45s` / `12 min` / `1 h 25 min` */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.max(1, Math.round(totalSeconds))}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/** `14:35` for today, `tomorrow 09:10`, or `18.07, 09:10` further out. */
export function formatFinishTime(finish: Date, now: Date = new Date()): string {
  const hm = `${String(finish.getHours()).padStart(2, '0')}:${String(finish.getMinutes()).padStart(2, '0')}`;
  const sameDay = finish.toDateString() === now.toDateString();
  if (sameDay) return `~${hm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (finish.toDateString() === tomorrow.toDateString()) return `tomorrow ~${hm}`;
  return `${String(finish.getDate()).padStart(2, '0')}.${String(finish.getMonth() + 1).padStart(2, '0')}, ~${hm}`;
}
