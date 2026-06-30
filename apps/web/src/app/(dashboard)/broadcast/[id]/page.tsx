'use client';

import { useParams } from 'next/navigation';
import { BroadcastDetail } from '@/components/broadcast/BroadcastDetail';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';

export default function BroadcastDetailPage() {
  const params = useParams();
  const id = params.id as string;
  return (
    <RequireOrgContext>
      <BroadcastDetail id={id} />
    </RequireOrgContext>
  );
}
