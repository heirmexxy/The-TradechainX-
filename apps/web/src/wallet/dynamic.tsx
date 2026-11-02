"use client";

// Dynamic embedded wallets, signed in with the TradeChainX session (no Dynamic login screen).
//
// Dashboard setup (app.dynamic.xyz → your environment):
//   1. Sign-in methods → "Third-party auth" / external JWT: Issuer = <API_URL>,
//      JWKS URL = <API_URL>/.well-known/jwks.json.
//   2. Embedded wallets → enable, create on sign-up, EVM.
//   3. Chains → enable your chain (Polygon / Amoy). Optional: gas sponsorship via account abstraction.
// Env: NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID.
//
// Written against @dynamic-labs/sdk-react-core v4. Check "Authenticate with an external JWT" in the
// Dynamic docs if a name differs in your installed version.
import { useEffect, useMemo, useRef } from "react";
import { DynamicContextProvider, useDynamicContext, useExternalAuth } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors, isEthereumWallet } from "@dynamic-labs/ethereum";
import type { Address, Hex, WalletClient } from "viem";
import { chain, RPC_URL } from "@/lib/chain";
import type { Call } from "@/lib/calls";
import type { WalletAdapter } from "./types";
import { getWalletToken, sendWithViem, waitFor } from "./shared";

type Props = { onAdapter: (a: WalletAdapter) => void };

export default function DynamicRoot({ onAdapter }: Props) {
  const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID;
  if (!environmentId) throw new Error("NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID is not set.");
  return (
    <DynamicContextProvider
      settings={{
        environmentId,
        walletConnectors: [EthereumWalletConnectors],
        overrides: {
          evmNetworks: [
            {
              chainId: chain.id,
              networkId: chain.id,
              name: chain.name,
              rpcUrls: [RPC_URL],
              nativeCurrency: chain.nativeCurrency,
              blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
              iconUrls: [],
            },
          ],
        },
      }}
    >
      <Bridge onAdapter={onAdapter} />
    </DynamicContextProvider>
  );
}

function Bridge({ onAdapter }: Props) {
  const { primaryWallet, handleLogOut } = useDynamicContext();
  const { signInWithExternalJwt } = useExternalAuth();
  const live = useRef<{ wallet: typeof primaryWallet }>({ wallet: null });
  live.current.wallet = primaryWallet;

  const adapter = useMemo<WalletAdapter>(() => {
    const client = async (): Promise<{ client: WalletClient; account: Address }> => {
      const w = live.current.wallet;
      if (!w || !isEthereumWallet(w)) throw new Error("Your account is still being set up.");
      return { client: (await w.getWalletClient(String(chain.id))) as unknown as WalletClient, account: w.address as Address };
    };
    return {
      kind: "dynamic",
      async connect() {
        const { token, userId } = await getWalletToken();
        await signInWithExternalJwt({ externalJwt: token, externalUserId: userId });
        const w = await waitFor(() => live.current.wallet, 45_000);
        if (!isEthereumWallet(w)) throw new Error("Unexpected wallet type.");
        if (w.connector.supportsNetworkSwitching()) await w.switchNetwork(chain.id);
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
        void handleLogOut();
      },
    };
  }, [signInWithExternalJwt, handleLogOut]);

  useEffect(() => onAdapter(adapter), [adapter, onAdapter]);
  return null;
}
