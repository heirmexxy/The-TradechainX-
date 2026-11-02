import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4">
      <h1 className="text-h1">We couldn't find that page</h1>
      <p className="mt-3 text-slate">The link may be out of date, or the asset may have been closed.</p>
      <div className="mt-6 flex gap-4 text-sm">
        <Link href="/" className="underline">Home</Link>
        <Link href="/marketplace" className="underline">Marketplace</Link>
      </div>
    </div>
  );
}
