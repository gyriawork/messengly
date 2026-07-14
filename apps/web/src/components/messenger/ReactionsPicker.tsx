import React, { useState, useRef, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { EmojiClickData, Theme } from 'emoji-picker-react';

// emoji-picker-react is a large bundle — load it only when the picker opens.
const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false });

interface ReactionsPickerProps {
  onEmojiSelect: (emoji: string) => void;
  isLoading?: boolean;
}

export const ReactionsPicker: React.FC<ReactionsPickerProps> = ({
  onEmojiSelect,
  isLoading = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close picker when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        pickerRef.current &&
        !pickerRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleEmojiClick = (emojiObject: EmojiClickData) => {
    onEmojiSelect(emojiObject.emoji);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="Add reaction"
        aria-label="Add emoji reaction"
      >
        <span className="text-lg">😊</span>
      </button>

      {isOpen && (
        <div
          ref={pickerRef}
          className="absolute bottom-full right-0 mb-2 z-50 shadow-lg rounded-lg overflow-hidden"
        >
          <EmojiPicker
            onEmojiClick={handleEmojiClick}
            theme={Theme.LIGHT}
            width={350}
            height={400}
            searchPlaceHolder="Search emoji..."
          />
        </div>
      )}
    </div>
  );
};
