'use client';

import { create } from 'zustand';

interface UiState {
  /** Whether the left navigation is in its narrow (icon-only) state. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

// Shared so surfaces that sit next to the sidebar (e.g. the full-window import
// modal) can line up with the main content card instead of guessing its width.
export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed: boolean) => set({ sidebarCollapsed: collapsed }),
}));
