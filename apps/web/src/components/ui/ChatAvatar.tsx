'use client';

import { cn } from '@/lib/utils';
import { getAvatarColor, getInitials } from '@/lib/chat-utils';
import { MessengerIcon } from './MessengerIcon';

type MessengerType = 'telegram' | 'slack' | 'whatsapp' | 'gmail' | 'teams';

interface ChatAvatarProps {
  name: string;
  messenger: MessengerType;
  size?: number;
  className?: string;
}

function getBadgeSize(avatarSize: number): number {
  if (avatarSize <= 36) return 14;
  if (avatarSize <= 40) return 18;
  return 22;
}

export function ChatAvatar({ name, messenger, size = 40, className }: ChatAvatarProps) {
  const initials = getInitials(name);
  const bgColor = getAvatarColor(name);
  const badgeSize = getBadgeSize(size);
  const fontSize = size <= 36 ? 12 : size <= 40 ? 14 : Math.round(size * 0.34);

  return (
    <div className={cn('relative inline-flex flex-shrink-0', className)}>
      <div
        className="flex items-center justify-center rounded-avatar font-bold text-white"
        style={{
          width: size,
          height: size,
          backgroundColor: bgColor,
          fontSize,
        }}
      >
        {initials}
      </div>
      <div
        className="absolute flex items-center justify-center rounded-full border-2 border-white bg-white overflow-hidden"
        style={{
          width: badgeSize,
          height: badgeSize,
          bottom: -3,
          right: -3,
        }}
      >
        <MessengerIcon messenger={messenger} size={badgeSize} />
      </div>
    </div>
  );
}
