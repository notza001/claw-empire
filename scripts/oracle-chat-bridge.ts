#!/usr/bin/env tsx
/**
 * Oracle Chat Bridge
 *
 * Polls oracle-chats.db for new messages from SenaWang/SenaChin
 * and forwards them to Claw-Empire inbox as CEO directives.
 *
 * Usage:
 *   tsx scripts/oracle-chat-bridge.ts          # Run once
 *   tsx scripts/oracle-chat-bridge.ts --watch   # Poll every 30s
 *
 * Requires:
 *   INBOX_WEBHOOK_SECRET in .env
 *   oracle-chats.db at ~/.oracle-shared/oracle-chats.db
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ORACLE_CHAT_DB = path.join(
  process.env.HOME || "",
  ".oracle-shared",
  "oracle-chats.db",
);
const CLAW_EMPIRE_URL = process.env.CLAW_EMPIRE_URL || "http://127.0.0.1:8790";
const STATE_FILE = path.join(import.meta.dirname || __dirname, ".chat-bridge-state.json");

// Load .env
try {
  const envPath = path.join(import.meta.dirname || __dirname, "..", ".env");
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const INBOX_SECRET = process.env.INBOX_WEBHOOK_SECRET || "";

interface ChatMessage {
  id: number;
  conversation_id: number;
  speaker: string;
  content: string;
  created_at: string;
}

function loadState(): { lastMessageId: number } {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastMessageId: 0 };
  }
}

function saveState(state: { lastMessageId: number }) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
}

async function forwardToInbox(message: ChatMessage) {
  const body = {
    source: "oracle-chat",
    text: `[${message.speaker}] ${message.content}`,
    author: message.speaker,
    agent_rules_version: 2,
  };

  try {
    const res = await fetch(`${CLAW_EMPIRE_URL}/api/inbox`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inbox-secret": INBOX_SECRET,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      console.log(`✅ Forwarded: [${message.speaker}] ${message.content.slice(0, 60)}...`);
    } else {
      console.error(`❌ Failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error(`❌ Connection error:`, err);
  }
}

async function poll() {
  if (!fs.existsSync(ORACLE_CHAT_DB)) {
    console.log("⚠️ oracle-chats.db not found:", ORACLE_CHAT_DB);
    return;
  }

  const db = new DatabaseSync(ORACLE_CHAT_DB, { readOnly: true });
  const state = loadState();

  try {
    const messages = db
      .prepare(
        "SELECT id, conversation_id, speaker, content, created_at FROM messages WHERE id > ? ORDER BY id LIMIT 20",
      )
      .all(state.lastMessageId) as ChatMessage[];

    if (messages.length === 0) {
      console.log("📭 No new messages");
      return;
    }

    console.log(`📬 ${messages.length} new messages`);

    for (const msg of messages) {
      // Only forward messages that look like directives (start with $ or contain task keywords)
      const isDirective =
        msg.content.startsWith("$") ||
        msg.content.includes("oracle_learn") ||
        msg.content.includes("handoff") ||
        msg.content.includes("@");

      if (isDirective) {
        await forwardToInbox(msg);
      }

      state.lastMessageId = msg.id;
    }

    saveState(state);
  } finally {
    db.close();
  }
}

// Main
const isWatch = process.argv.includes("--watch");

if (isWatch) {
  console.log("🔄 Oracle Chat Bridge — watching every 30s");
  const run = async () => {
    await poll();
    setTimeout(run, 30_000);
  };
  run();
} else {
  poll().then(() => process.exit(0));
}
