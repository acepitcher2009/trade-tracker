import { useSyncExternalStore } from 'react';
export const useSnap = (data) => useSyncExternalStore(data.subscribe, data.getSnapshot);
