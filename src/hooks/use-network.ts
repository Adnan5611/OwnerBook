import NetInfo from '@react-native-community/netinfo';

export type NetworkState = {
  /**
   * null means "not determined yet" (the OS has not answered, or the reachability
   * probe is still running). It must never be rendered as offline.
   */
  connected: boolean | null;
};

/**
 * One place decides what offline means so every screen reports the same honest
 * status: connected, offline, or still checking.
 */
export function useNetwork(): NetworkState {
  const network = NetInfo.useNetInfo();
  const connected =
    network.isConnected === false || network.isInternetReachable === false
      ? false
      : network.isConnected === true && network.isInternetReachable === true
        ? true
        : null;
  return { connected };
}
