import { randomBytes } from "node:crypto";
import type {
  EmailAdapter,
  EmailSession,
  SessionOptions,
  SessionCredentials,
  EmailSummary,
  Email,
} from "./types.js";

/**
 * Default Supabase project URL — embedded so Hetzner boxes can use it
 * without local env var setup. The anon key is designed to be public.
 */
const DEFAULT_SUPABASE_URL = "https://zrxvitrdnddehfjhioqj.supabase.co";

/**
 * Default publishable key — public by design (enforced by Supabase RLS).
 * Overridable via THROWMAIL_SUPABASE_ANON_KEY env var.
 */
const DEFAULT_ANON_KEY = "sb_publishable_hODIKaHycxi4Ul_Psxo4cw_-fqAUL9Z";

const THROWMAIL_DOMAIN = "throwmail.supa";
const TABLE = "throwmail_messages";

/**
 * Get effective Supabase URL (env override or default)
 */
function getSupabaseUrl(): string {
  return process.env.THROWMAIL_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
}

/**
 * Get effective anon key (env override or default)
 */
function getAnonKey(): string {
  return process.env.THROWMAIL_SUPABASE_ANON_KEY ?? DEFAULT_ANON_KEY;
}

/**
 * Build standard Supabase REST API headers
 */
function supabaseHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = getAnonKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

/**
 * Generate a random hex address local part
 */
function generateAddressLocal(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Supabase-backed mail session.
 *
 * Messages are stored in the throwmail_messages table.
 * Addresses are {randomHex}@throwmail.supa — no external service needed.
 */
class SupabaseMailSession implements EmailSession {
  readonly address: string;
  readonly login: string;
  readonly domain: string;
  readonly credentials: SessionCredentials;

  constructor(credentials: SessionCredentials) {
    this.address = credentials.address;
    this.login = credentials.login;
    this.domain = credentials.domain;
    this.credentials = credentials;
  }

  async list(maxResults?: number): Promise<EmailSummary[]> {
    const url = new URL(`${getSupabaseUrl()}/rest/v1/${TABLE}`);
    url.searchParams.set("to_address", `eq.${this.address}`);
    url.searchParams.set("select", "*");
    url.searchParams.set("order", "created_at.asc");
    if (maxResults) {
      url.searchParams.set("limit", String(maxResults));
    }

    const res = await fetch(url.toString(), {
      headers: supabaseHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Failed to list messages: ${res.status} ${res.statusText}`);
    }

    interface SupabaseMessage {
      id: string;
      to_address: string;
      from_address: string;
      subject: string;
      body: string;
      created_at: string;
    }

    const data = (await res.json()) as SupabaseMessage[];
    const summaries: EmailSummary[] = data.map((msg) => ({
      id: msg.id,
      from: msg.from_address,
      subject: msg.subject || "(no subject)",
      date: msg.created_at,
    }));

    return summaries;
  }

  async read(id: string): Promise<Email> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid message ID: ${id}`);
    }
    const url = new URL(`${getSupabaseUrl()}/rest/v1/${TABLE}`);
    url.searchParams.set("id", `eq.${id}`);
    url.searchParams.set("to_address", `eq.${this.address}`);
    url.searchParams.set("select", "*");

    const res = await fetch(url.toString(), {
      headers: supabaseHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Failed to read message: ${res.status} ${res.statusText}`);
    }

    interface SupabaseMessage {
      id: string;
      to_address: string;
      from_address: string;
      subject: string;
      body: string;
      created_at: string;
    }

    const data = (await res.json()) as SupabaseMessage[];
    if (data.length === 0) {
      throw new Error(`Message not found: ${id}`);
    }

    const msg = data[0];
    return {
      id: msg.id,
      from: msg.from_address,
      subject: msg.subject || "(no subject)",
      date: msg.created_at,
      textBody: msg.body,
      htmlBody: "",
      attachments: [],
    };
  }

  async send(to: string, subject: string, body: string): Promise<void> {
    if (!to || !to.includes('@') || to.length > 254) {
      throw new Error(`Invalid recipient address: ${to}`);
    }
    if (subject.length > 998) {
      throw new Error('Subject exceeds maximum length (998 characters)');
    }
    const url = `${getSupabaseUrl()}/rest/v1/${TABLE}`;

    const res = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders({
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify({
        to_address: to,
        from_address: this.address,
        subject,
        body,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to send message: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
  }
}

/**
 * Supabase-backed mail adapter.
 *
 * Supports both sending and receiving. No external credentials needed —
 * uses the embedded anon key which is restricted by RLS policies.
 */
export class SupabaseMailAdapter implements EmailAdapter {
  readonly name = "supabase";
  readonly supportsSend = true;

  async createSession(_options: SessionOptions = {}): Promise<EmailSession> {
    const login = generateAddressLocal();
    const domain = THROWMAIL_DOMAIN;
    const address = `${login}@${domain}`;

    const credentials: SessionCredentials = {
      address,
      login,
      domain,
    };

    return new SupabaseMailSession(credentials);
  }

  restoreSession(credentials: SessionCredentials): EmailSession {
    return new SupabaseMailSession(credentials);
  }
}
