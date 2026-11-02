"use client";

// One wallet context for the whole app. Which provider backs it is configuration only:
//   NEXT_PUBLIC_WALLET_PROVIDER = dev | privy | dynamic | sequence
// and how gas is paid:
//   NEXT_PUBLIC_GAS_MODE = sponsored (provider paymaster) | station (our API tops up) | none
// See docs/WALLETS.md.
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { parseEther, type Address, type Hex } from "viem";
import { api } from "@/lib/api";
import { publicClient } from "@/lib/chain";
import type { Call } from "@/lib/calls";
import { useSession, type Profile } from "@/lib/session";
import type { WalletAdapter, WalletProviderKind } from "./types";
import { DevWallet } from "./dev";
import { SequenceWallet } from "./sequence";

const PROVIDER = (process.env.NEXT_PUBLIC_WALLET_PROVIDER ?? "dev") as WalletProviderKind;
const GAS_MODE = (process.env.NEXT_PUBLIC_GAS_MODE ?? (PROVIDER === "dev" ? "none" : "station")) as "sponsored" | "station" | "none";
// Ask the gas station for a top-up below this native balance (matches GAS_STATION_MIN_BALANCE on the API).
const GAS_MIN = parseEther(process.env.NEXT_PUBLIC_GAS_MIN_BALANCE ?? "0.05");

type RootProps = { onAdapter: (a: WalletAdapter) => void };
// React-based SDKs (Privy, Dynamic) need a provider component; they're loaded only when selected,
// so the other SDKs never ship in the bundle.
const ROOTS: Partial<Record<WalletProviderKind, ComponentType<RootProps>>> = {
  privy: lazy(() => import("./privy")),
  dynamic: lazy(() => import("./dynamic")),
};

function createClassAdapter(): WalletAdapter | null {
  if (PROVIDER === "sequence") {
    return new SequenceWallet(
      process.env.NEXT_PUBLIC_SEQUENCE_PROJECT_ACCESS_KEY ?? "",
      process.env.NEXT_PUBLIC_SEQUENCE_WAAS_CONFIG_KEY ?? "",
    );
  }
  if (PROVIDER === "dev") return new DevWallet(process.env.NEXT_PUBLIC_DEV_WALLET_SEED ?? "tradechainx-local-dev-seed");
  return null;
}

export type StepState = { summary: string; status: "waiting" | "running" | "done" | "failed"; hash?: Hex };

type WalletCtx = {
  provider: WalletProviderKind;
  address: Address | null;
  status: "idle" | "connecting" | "ready" | "mismatch" | "error";
  error: string | null;
  /** Runs calls in order, waiting for each to confirm. Reports progress per step. */
  run(calls: Call[], onProgress?: (steps: StepState[]) => void): Promise<Hex[]>;
};

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const adapterRef = useRef<WalletAdapter | null>(null);
  adapterRef.current = adapter;
  const { data: user } = useSession();
  const qc = useQueryClient();
  const [address, setAddress] = useState<Address | null>(null);
  const [status, setStatus] = useState<WalletCtx["status"]>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ROOTS[PROVIDER]) return; // the root component hands us its adapter
    try {
      setAdapter(createClassAdapter());
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Wallet provider misconfigured.");
    }
  }, []);

  const onAdapter = useCallback((a: WalletAdapter) => setAdapter(a), []);

  // Silently connect the user's wallet after sign-in, and link it to the account the first time.
  useEffect(() => {
    if (!user) {
      adapterRef.current?.disconnect();
      setAddress(null);
      setStatus("idle");
      return;
    }
    if (!adapter) return;
    let cancelled = false;
    (async () => {
      try {
        setStatus("connecting");
        const addr = await adapter.connect(user.email);
        if (cancelled) return;
        if (!user.walletAddress) {
          await linkWallet(adapter, addr);
          await qc.invalidateQueries({ queryKey: ["me"] });
        } else if (user.walletAddress.toLowerCase() !== addr.toLowerCase()) {
          setStatus("mismatch");
          setError("This sign-in created a different account key from the one on file. Contact support.");
          return;
        }
        setAddress(addr);
        setStatus("ready");
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : "Couldn't set up your account.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.walletAddress, user?.email, adapter, qc]);

  const run = useCallback<WalletCtx["run"]>(async (calls, onProgress) => {
    const a = adapterRef.current;
    const account = a?.address();
    if (!a || !account) throw new Error("Your account is still being set up. Try again in a moment.");
    await ensureGas(account);
    const steps: StepState[] = calls.map((c) => ({ summary: c.summary, status: "waiting" }));
    const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
    const hashes: Hex[] = [];
    for (let i = 0; i < calls.length; i++) {
      steps[i]!.status = "running";
      emit();
      try {
        const hash = await a.send(calls[i]!);
        steps[i]!.hash = hash;
        emit();
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("The network rejected this step.");
        steps[i]!.status = "done";
        hashes.push(hash);
        emit();
      } catch (e) {
        steps[i]!.status = "failed";
        emit();
        throw e;
      }
    }
    return hashes;
  }, []);

  const value = useMemo(() => ({ provider: PROVIDER, address, status, error, run }), [address, status, error, run]);
  const Root = ROOTS[PROVIDER];
  return (
    <Ctx.Provider value={value}>
      {Root && (
        <Suspense fallback={null}>
          <Root onAdapter={onAdapter} />
        </Suspense>
      )}
      {children}
    </Ctx.Provider>
  );
}

/**
 * With GAS_MODE=station the user's wallet pays its own gas, topped up by our API's gas station
 * (small, rate-limited, verified users only). With "sponsored" the provider's paymaster pays and
 * nothing happens here. The user never sees any of this.
 */
async function ensureGas(account: Address) {
  if (GAS_MODE !== "station") return;
  const balance = await publicClient.getBalance({ address: account });
  if (balance >= GAS_MIN) return;
  const { result } = await api<{ result: "sent" | "not_needed" | "skipped"; hash?: Hex }>("/me/gas", { body: {} });
  if (result === "sent") {
    // Wait until the top-up lands so the first step doesn't fail for lack of gas.
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      if ((await publicClient.getBalance({ address: account })) >= GAS_MIN / 2n) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function linkWallet(adapter: WalletAdapter, address: Address) {
  const { message } = await api<{ message: string }>("/me/wallet/challenge", { body: { address } });
  const signature = await adapter.signMessage(message);
  await api<{ user: Profile }>("/me/wallet", { body: { address, signature } });
}

export function useWallet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
