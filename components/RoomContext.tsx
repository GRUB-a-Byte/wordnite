'use client';

import { createContext, useContext } from 'react';
import type { RoomClient } from '@/lib/client/roomClient';

export const RoomClientContext = createContext<RoomClient | null>(null);

export function useRoomClient(): RoomClient {
  const client = useContext(RoomClientContext);
  if (!client) throw new Error('useRoomClient must be used inside a room');
  return client;
}
