import { env } from "../env.ts";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

class ConsoleMailer implements Mailer {
  async send(to: string, subject: string, text: string) {
    console.log(`\n[mail] to=${to} subject="${subject}"\n${text}\n`);
  }
}

class SendGridMailer implements Mailer {
  constructor(private apiKey: string, private from: string) {}
  async send(to: string, subject: string, text: string) {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: this.from, name: "TradeChainX" },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid error ${res.status}: ${await res.text()}`);
  }
}

export const mailer: Mailer =
  env.EMAIL_PROVIDER === "sendgrid" ? new SendGridMailer(env.SENDGRID_API_KEY!, env.EMAIL_FROM) : new ConsoleMailer();
