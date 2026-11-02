"use client";

// Privy embedded wallets, signed in with the TradeChainX session (no Privy login screen).
//
// Dashboard setup (dashboard.privy.io → your app):
//   1. Authentication → "JWT-based auth" (custom auth): JWKS URL = <API_URL>/.well-known/jwks.json,
//      user id claim = "sub". Turn off Privy's own login methods.
//   2. Embedded wallets → Ethereum → create on login for all users.
//   3. Optional gas sponsorship: enable Smart Wallets + a paymaster for your chain in the dashboard.
// Env: NEXT_PUBLIC_PRIVY_APP_ID.
//
// Written against @privy-io/react-auth v2. If a hook name differs in your installed version, the
// Privy docs "JWT-based auth" and "Embedded wallets → Get a wallet" pages have the current names.
import { useEffect, useMemo, useRef, useState } from "react";
import { PrivyProvider, usePrivy, useWallets, useSubscribeToJwtAuthWithFlag } from "@privy-io/react-auth";
import type { Address, Hex } from "viem";
import { chain } from "@/lib/chain";
import type { Call } from "@/lib/calls";
import type { WalletAdapter } from "./types";
import { clientFromProvider, getWalletToken, sendWithViem, waitFor } from "./shared";

type Props = { onAdapter: (a: WalletAdapter) => void };

export default function PrivyRoot({ onAdapter }: Props) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) throw new Error("NEXT_PUBLIC_PRIVY_APP_ID is not set.");
  return (
    <PrivyProvider
      appId={appId}
      config={{
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: false },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <Bridge onAdapter={onAdapter} />
    </PrivyProvider>
  );
}

type PrivyWallet = { address: string; walletClientType: string; getEthereumProvider(): Promise<unknown>; switchChain(id: number): Promise<void> };

function Bridge({ onAdapter }: Props) {
  const [wantSession, setWantSession] = useState(false);
  const { logout } = usePrivy();
  const { wallets } = useWallets();
  const embedded = (wallets as PrivyWallet[]).find((w) => w.walletClientType === "privy") ?? null;
  const live = useRef<{ wallet: PrivyWallet | null }>({ wallet: null });
  live.current.wallet = embedded;

  // Privy follows our session: when wantSession is true it asks for a fresh TradeChainX wallet token.
  useSubscribeToJwtAuthWithFlag({
    isAuthenticated: wantSession,
    isLoading: false,
    getExternalJwt: async () => (wantSession ? (await getWalletToken()).token : undefined),
  });

  const adapter = useMemo<WalletAdapter>(() => {
    const client = async () => {
      const w = live.current.wallet;
      if (!w) throw new Error("Your account is still being set up.");
      const provider = (await w.getEthereumProvider()) as Parameters<typeof clientFromProvider>[0];
      return { client: clientFromProvider(provider, w.address as Address), account: w.address as Address };
    };
    return {
      kind: "privy",
      async connect() {
        setWantSession(true);
        const w = await waitFor(() => live.current.wallet, 45_000);
        await w.switchChain(chain.id);
        return w.address as Address;
      },
      address: () => (live.current.wallet?.address as Address | undefined) ?? null,
      async signMessage(message: string): Promise<Hex> {
        const { client: c, account } = await client();
        return c.signMessage({ account, message });
      },
      async send(call: Call): Promise<Hex> {
        const { client: c, account } = await client();
        return sendWithViem(c, account, call);
      },
      disconnect() {
        setWantSession(false);
        void logout();
      },
    };
  }, [logout]);

  useEffect(() => onAdapter(adapter), [adapter, onAdapter]);
  return null;
}
