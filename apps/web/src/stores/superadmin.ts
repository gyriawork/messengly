'use client';

import { create } from 'zustand';

interface SuperadminState {
  selectedOrgId: string | null;
  selectedOrgName: string | null;
  selectedOrgLogo: string | null;
  setOrg: (id: string, name: string, logo?: string | null) => void;
  clearOrg: () => void;
  hydrate: () => void;
}

export const useSuperadminStore = create<SuperadminState>((set) => ({
  selectedOrgId: null,
  selectedOrgName: null,
  selectedOrgLogo: null,

  setOrg: (id: string, name: string, logo: string | null = null) => {
    localStorage.setItem('superadmin_orgId', id);
    localStorage.setItem('superadmin_orgName', name);
    if (logo) localStorage.setItem('superadmin_orgLogo', logo);
    else localStorage.removeItem('superadmin_orgLogo');
    set({ selectedOrgId: id, selectedOrgName: name, selectedOrgLogo: logo });
  },

  clearOrg: () => {
    localStorage.removeItem('superadmin_orgId');
    localStorage.removeItem('superadmin_orgName');
    localStorage.removeItem('superadmin_orgLogo');
    set({ selectedOrgId: null, selectedOrgName: null, selectedOrgLogo: null });
  },

  hydrate: () => {
    if (typeof window === 'undefined') return;
    const orgId = localStorage.getItem('superadmin_orgId');
    const orgName = localStorage.getItem('superadmin_orgName');
    if (orgId && orgName) {
      set({
        selectedOrgId: orgId,
        selectedOrgName: orgName,
        selectedOrgLogo: localStorage.getItem('superadmin_orgLogo'),
      });
    }
  },
}));
