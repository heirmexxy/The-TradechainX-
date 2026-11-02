// DEVELOPMENT ONLY. Gives new dev wallets gas and mock USDC so the whole flow can be clicked through
// locally or on Amoy. loadEnv() refuses to start production with DEV_TOOLS or DEV_FAUCET_KEY set.
import { createWalletClient, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient, usdc } from "../chain.ts";
import { env } from "../env.ts";

const LOCAL_CHAIN_ID = 31337;

export async function fundDevWallet(address: Address, usdcAmount = 100_000n * 1_000_000n) {
  if (!env.DEV_TOOLS || !env.DEV_FAUCET_KEY) return;
  const account = privateKeyToAccount(env.DEV_FAUCET_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(env.RPC_URL) });

  if (env.CHAIN_ID === LOCAL_CHAIN_ID) {
    const balance = await publicClient.getBalance({ address });
    if (balance < parseEther("0.5")) {
      const hash = await wallet.sendTransaction({ to: address, value: parseEther("1") });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }
  // MockUSDC has an open mint; on a real USDC deployment this reverts and is skipped.
  const hash = await wallet.writeContract({
    address: usdc.address,
    abi: usdc.abi,
    functionName: "mint",
    args: [address, usdcAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}
