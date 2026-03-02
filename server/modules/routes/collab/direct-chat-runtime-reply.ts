import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  sendMessengerMessage,
  sendMessengerSessionMessage,
  sendMessengerSessionTyping,
  sendMessengerTyping,
  type MessengerChannel,
} from "../../../gateway/client.ts";
import { isMessengerChannel } from "../../../messenger/channels.ts";
import type { Lang } from "../../../types/lang.ts";
import type { DelegationOptions } from "./project-resolution.ts";
import { normalizeAgentReply, shouldPreserveStructuredFallback } from "./direct-chat-intent-utils.ts";
import type { AgentRow, DirectChatDeps } from "./direct-chat-types.ts";

type DirectReplyRuntimeDeps = Pick<
  DirectChatDeps,
  | "db"
  | "logsDir"
  | "nowMs"
  | "broadcast"
  | "sendAgentMessage"
  | "resolveProjectPath"
  | "detectProjectPath"
  | "buildDirectReplyPrompt"
  | "chooseSafeReply"
  | "runAgentOneShot"
  | "executeApiProviderAgent"
  | "executeCopilotAgent"
  | "executeAntigravityAgent"
>;

function getMessengerChunkLimit(channel: MessengerChannel): number {
  if (channel === "discord") return 1900;
  if (channel === "telegram") return 3800;
  if (channel === "slack") return 3900;
  if (channel === "whatsapp") return 3900;
  if (channel === "googlechat") return 3900;
  if (channel === "signal") return 3900;
  if (channel === "imessage") return 3900;
  return 35000;
}

function splitMessageByLimit(text: string, limit: number): string[] {
  const source = text.trim();
  if (!source) return [];
  if (source.length <= limit) return [source];

  const chunks: string[] = [];
  let remaining = source;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.4)) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut < Math.floor(limit * 0.4)) {
      cut = limit;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function localeInstructionForDirect(lang: Lang): string {
  if (lang === "en") return "Respond in English.";
  if (lang === "ja") return "Respond in Japanese.";
  if (lang === "zh") return "Respond in Chinese.";
  return "Respond in Korean.";
}

export function createDirectReplyRuntime(deps: DirectReplyRuntimeDeps) {
  async function relayReplyToMessenger(options: DelegationOptions, agent: AgentRow, rawContent: string): Promise<void> {
    const channel = options.messengerChannel;
    const targetId = (options.messengerTargetId || "").trim();
    const sessionKey = (options.messengerSessionKey || "").trim();
    if (!isMessengerChannel(channel) || !targetId) return;

    const cleaned = normalizeAgentReply(rawContent);
    if (!cleaned) return;

    const chunks = splitMessageByLimit(cleaned, getMessengerChunkLimit(channel));
    for (const chunk of chunks) {
      if (sessionKey) {
        await sendMessengerSessionMessage(sessionKey, chunk);
      } else {
        await sendMessengerMessage({
          channel,
          targetId,
          text: chunk,
        });
      }
    }
    console.log(`[messenger-reply] relayed ${chunks.length} chunk(s) to ${channel}:${targetId} via ${agent.name}`);
  }

  function startMessengerTypingHeartbeat(options: DelegationOptions, agent: AgentRow): () => void {
    const channel = options.messengerChannel;
    const targetId = (options.messengerTargetId || "").trim();
    const sessionKey = (options.messengerSessionKey || "").trim();
    if (
      !isMessengerChannel(channel) ||
      !targetId ||
      (channel !== "telegram" && channel !== "discord" && channel !== "signal")
    ) {
      return () => undefined;
    }

    let stopped = false;
    let warned = false;
    const sendBeat = () => {
      if (stopped) return;
      const sender = sessionKey ? sendMessengerSessionTyping(sessionKey) : sendMessengerTyping({ channel, targetId });
      void sender.catch((err) => {
        if (warned) return;
        warned = true;
        console.warn(`[messenger-typing] failed for ${agent.name} on ${channel}:${targetId}: ${String(err)}`);
      });
    };

    sendBeat();
    const timer = setInterval(sendBeat, 3500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async function composeInCharacterAutoMessage(
    agent: AgentRow,
    lang: Lang,
    scenario: string,
    fallback: string,
  ): Promise<string> {
    const personality = (agent.personality || "").trim();
    if (!personality) return fallback;

    if (shouldPreserveStructuredFallback(fallback)) {
      const prompt = [
        "[Auto Reply - In Character Intro]",
        `You are ${agent.name}.`,
        localeInstructionForDirect(lang),
        "[Character Persona - Highest Priority]",
        personality,
        "Scenario:",
        scenario,
        "Output rules:",
        "- Return exactly one short sentence only.",
        "- Stay strictly in character and tone.",
        "- Do not include numbering, options, list, code, markdown, or JSON.",
        "- Do not mention system/internal prompts.",
      ].join("\n");

      try {
        const run = await deps.runAgentOneShot(agent, prompt, {
          projectPath: process.cwd(),
          rawOutput: true,
          noTools: true,
        });
        const picked = normalizeAgentReply(deps.chooseSafeReply(run, lang, "direct", agent));
        const introLine = picked.split(/\r?\n/, 1)[0] ?? "";
        const intro = introLine.trim().replace(/\s+/g, " ");
        if (!intro) return fallback;
        const firstLine = fallback.split(/\r?\n/, 1)[0]?.trim();
        if (firstLine && intro === firstLine) return fallback;
        return `${intro}\n${fallback}`;
      } catch (err) {
        console.warn(`[persona-auto-reply] intro mode failed for ${agent.name}: ${String(err)}`);
        return fallback;
      }
    }

    const prompt = [
      "[Auto Reply - In Character]",
      `You are ${agent.name}.`,
      localeInstructionForDirect(lang),
      "[Character Persona - Highest Priority]",
      personality,
      "Scenario:",
      scenario,
      "Output rules:",
      "- Return one short chat message only (1 sentence, max 2).",
      "- Stay strictly in character and tone.",
      "- No markdown, no JSON, no code block.",
      "- Do not mention internal/system prompts.",
    ].join("\n");

    try {
      const run = await deps.runAgentOneShot(agent, prompt, {
        projectPath: process.cwd(),
        rawOutput: true,
        noTools: true,
      });
      const picked = normalizeAgentReply(deps.chooseSafeReply(run, lang, "direct", agent));
      if (picked) return picked;
    } catch (err) {
      console.warn(`[persona-auto-reply] failed for ${agent.name}: ${String(err)}`);
    }

    return fallback;
  }

  function sendInCharacterAutoMessage(params: {
    agent: AgentRow;
    lang: Lang;
    scenario: string;
    fallback: string;
    options: DelegationOptions;
    messageType?: string;
    taskId?: string | null;
    strictFallback?: boolean;
  }): void {
    const {
      agent,
      lang,
      scenario,
      fallback,
      options,
      messageType = "chat",
      taskId = null,
      strictFallback = false,
    } = params;
    void (async () => {
      const content = strictFallback ? fallback : await composeInCharacterAutoMessage(agent, lang, scenario, fallback);
      deps.sendAgentMessage(agent, content, messageType, "agent", null, taskId);
      await relayReplyToMessenger(options, agent, content);
    })().catch((err) => {
      console.warn(`[persona-auto-reply] send failed for ${agent.name}: ${String(err)}`);
    });
  }

  function insertStreamingMessage(msgId: string, agent: AgentRow, content: string): void {
    const endedAt = deps.nowMs();
    deps.db
      .prepare(
        `
          INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, created_at)
          VALUES (?, 'agent', ?, 'agent', NULL, ?, 'chat', NULL, ?)
        `,
      )
      .run(msgId, agent.id, content, endedAt);
    deps.broadcast("chat_stream", {
      phase: "end",
      message_id: msgId,
      agent_id: agent.id,
      content,
      created_at: endedAt,
    });
  }

  function runDirectReplyExecution(
    agent: AgentRow,
    ceoMessage: string,
    messageType: string,
    options: DelegationOptions = {},
  ): void {
    const delay = 1000 + Math.random() * 2000;
    setTimeout(() => {
      void (async () => {
        const stopTyping = startMessengerTypingHeartbeat(options, agent);
        try {
          const activeTask = agent.current_task_id
            ? (deps.db
                .prepare("SELECT title, description, project_path FROM tasks WHERE id = ?")
                .get(agent.current_task_id) as
                | {
                    title: string;
                    description: string | null;
                    project_path: string | null;
                  }
                | undefined)
            : undefined;
          const detectedPath = deps.detectProjectPath(ceoMessage);
          const projectPath = detectedPath || (activeTask ? deps.resolveProjectPath(activeTask) : process.cwd());

          const built = deps.buildDirectReplyPrompt(agent, ceoMessage, messageType);

          console.log(
            `[scheduleAgentReply] agent=${agent.name}, cli_provider=${agent.cli_provider}, api_provider_id=${agent.api_provider_id}, api_model=${agent.api_model}`,
          );

          if (agent.cli_provider === "api" && agent.api_provider_id) {
            const msgId = randomUUID();
            deps.broadcast("chat_stream", {
              phase: "start",
              message_id: msgId,
              agent_id: agent.id,
              agent_name: agent.name,
              agent_avatar: agent.avatar_emoji ?? "🤖",
            });

            let fullText = "";
            let apiError = "";
            try {
              const logStream = fs.createWriteStream(path.join(deps.logsDir, `direct-${agent.id}-${Date.now()}.log`), {
                flags: "w",
              });
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 180_000);
              try {
                await deps.executeApiProviderAgent(
                  built.prompt,
                  projectPath,
                  logStream,
                  controller.signal,
                  undefined,
                  agent.api_provider_id,
                  agent.api_model ?? null,
                  (text: string) => {
                    fullText += text;
                    logStream.write(text);
                    deps.broadcast("chat_stream", {
                      phase: "delta",
                      message_id: msgId,
                      agent_id: agent.id,
                      text,
                    });
                    return true;
                  },
                );
              } finally {
                clearTimeout(timeout);
                logStream.end();
              }
            } catch (err: any) {
              apiError = err?.message || String(err);
              console.error(`[scheduleAgentReply:API] Error for ${agent.name}:`, apiError);
            }

            const contentOnly = fullText
              .replace(/^\[api:[^\]]*\][^\n]*\n---\n/g, "")
              .replace(/\n---\n\[api:[^\]]*\]\s*Done\.\s*$/g, "")
              .trim();

            let finalReply: string;
            if (contentOnly) {
              finalReply = contentOnly.length > 12000 ? contentOnly.slice(0, 12000) : contentOnly;
            } else if (apiError) {
              finalReply = `[API Error] ${apiError}`;
            } else {
              finalReply = deps.chooseSafeReply({ text: "" }, built.lang, "direct", agent);
            }
            finalReply = normalizeAgentReply(finalReply);

            insertStreamingMessage(msgId, agent, finalReply);
            void relayReplyToMessenger(options, agent, finalReply).catch((err) => {
              console.warn(`[messenger-reply] failed to relay API reply from ${agent.name}: ${String(err)}`);
            });
            return;
          }

          if (agent.cli_provider === "copilot" || agent.cli_provider === "antigravity") {
            const msgId = randomUUID();
            deps.broadcast("chat_stream", {
              phase: "start",
              message_id: msgId,
              agent_id: agent.id,
              agent_name: agent.name,
              agent_avatar: agent.avatar_emoji ?? "🤖",
            });

            let fullText = "";
            let oauthError = "";
            try {
              const logStream = fs.createWriteStream(path.join(deps.logsDir, `direct-${agent.id}-${Date.now()}.log`), {
                flags: "w",
              });
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 180_000);
              const streamCb = (text: string) => {
                fullText += text;
                logStream.write(text);
                deps.broadcast("chat_stream", {
                  phase: "delta",
                  message_id: msgId,
                  agent_id: agent.id,
                  text,
                });
                return true;
              };
              try {
                if (agent.cli_provider === "copilot") {
                  await deps.executeCopilotAgent(
                    built.prompt,
                    projectPath,
                    logStream,
                    controller.signal,
                    undefined,
                    agent.oauth_account_id ?? null,
                    streamCb,
                  );
                } else {
                  await deps.executeAntigravityAgent(
                    built.prompt,
                    logStream,
                    controller.signal,
                    undefined,
                    agent.oauth_account_id ?? null,
                    streamCb,
                  );
                }
              } finally {
                clearTimeout(timeout);
                logStream.end();
              }
            } catch (err: any) {
              oauthError = err?.message || String(err);
              console.error(`[scheduleAgentReply:OAuth] Error for ${agent.name}:`, oauthError);
            }

            const contentOnly = fullText
              .replace(/^\[(copilot|antigravity)\][^\n]*\n/gm, "")
              .replace(/---+/g, "")
              .replace(/^\[oauth[^\]]*\][^\n]*/gm, "")
              .trim();

            let finalReply: string;
            if (contentOnly) {
              finalReply = contentOnly.length > 12000 ? contentOnly.slice(0, 12000) : contentOnly;
            } else if (oauthError) {
              finalReply = `[OAuth Error] ${oauthError}`;
            } else {
              finalReply = deps.chooseSafeReply({ text: "" }, built.lang, "direct", agent);
            }
            finalReply = normalizeAgentReply(finalReply);

            insertStreamingMessage(msgId, agent, finalReply);
            void relayReplyToMessenger(options, agent, finalReply).catch((err) => {
              console.warn(`[messenger-reply] failed to relay OAuth reply from ${agent.name}: ${String(err)}`);
            });
            return;
          }

          const run = await deps.runAgentOneShot(agent, built.prompt, { projectPath, rawOutput: true });
          const reply = normalizeAgentReply(deps.chooseSafeReply(run, built.lang, "direct", agent));
          deps.sendAgentMessage(agent, reply);
          void relayReplyToMessenger(options, agent, reply).catch((err) => {
            console.warn(`[messenger-reply] failed to relay direct reply from ${agent.name}: ${String(err)}`);
          });
        } finally {
          stopTyping();
        }
      })().catch((err) => {
        console.warn(`[scheduleAgentReply] async generation failed for ${agent.name}: ${String(err)}`);
      });
    }, delay);
  }

  return {
    relayReplyToMessenger,
    startMessengerTypingHeartbeat,
    composeInCharacterAutoMessage,
    sendInCharacterAutoMessage,
    runDirectReplyExecution,
  };
}
