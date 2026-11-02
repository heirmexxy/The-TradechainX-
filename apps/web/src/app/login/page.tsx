"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { Profile } from "@/lib/session";
import { Button, Field, Input, Notice } from "@/components/ui";
import { Wordmark } from "@/components/SiteChrome";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const isNew = params?.get("new") === "1";

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: true; devCode?: string }>("/auth/request-code", { body: { email } });
      setDevCode(res.devCode ?? null);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send the code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api<{ user: Profile }>("/auth/verify", { body: { email, code } });
      qc.setQueryData(["me"], user);
      const next = params?.get("next");
      router.push(!user.userType && !user.adminRoles.length ? "/app/onboarding" : next && next.startsWith("/") ? next : "/app");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="mt-8 text-h1">{isNew ? "Create your account" : "Sign in"}</h1>
        <p className="mt-2 text-slate">
          {step === "email" ? "We'll email you a 6-digit code. No password needed." : `Enter the code we sent to ${email}.`}
        </p>

        {step === "email" ? (
          <form onSubmit={requestCode} className="mt-8 space-y-4">
            <Field label="Email">
              <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            {error && <Notice tone="bad">{error}</Notice>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Sending…" : "Email me a code"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-8 space-y-4">
            <Field label="Code">
              <Input
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </Field>
            {devCode && (
              <Notice tone="warn" title="Development mode">
                Your code is <strong>{devCode}</strong>.
              </Notice>
            )}
            {error && <Notice tone="bad">{error}</Notice>}
            <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
              {busy ? "Checking…" : "Continue"}
            </Button>
            <button type="button" className="w-full text-sm text-ink-700 underline" onClick={() => { setStep("email"); setCode(""); }}>
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
