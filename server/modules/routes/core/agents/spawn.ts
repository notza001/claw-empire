import path from "node:path";
import { notifyTaskStatus } from "../../../../gateway/client.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { buildWorkflowPackExecutionGuidance } from "../../../workflow/packs/execution-guidance.ts";
import { resolveVideoArtifactSpecForTask } from "../../../workflow/packs/video-artifact.ts";
import { ensureVideoPreprodRemotionBestPracticesSkill } from "../../../workflow/core/video-skill-bootstrap.ts";

export function registerAgentSpawnRoute(ctx: RuntimeContext): void {
  const {
    app,
    db,
    logsDir,
    createWorktree,
    ensureClaudeMd,
    ensureTaskExecutionSession,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getDeptRoleConstraint,
    normalizeTextField,
    appendTaskLog,
    getProviderModelConfig,
    getNextHttpAgentPid,
    nowMs,
    broadcast,
    launchApiProviderAgent,
    launchHttpAgent,
    spawnCliAgent,
    handleTaskRunComplete,
    resolveLang,
    pickL,
    l,
  } = ctx;
  const buildAvailableSkillsPromptBlock =
    ctx.buildAvailableSkillsPromptBlock ||
    ((provider: string) => `[Available Skills][provider=${provider || "unknown"}][unavailable]`);

  app.post("/api/agents/:id/spawn", (req, res) => {
    const id = String(req.params.id);
    let agent:
      | {
          id: string;
          name: string;
          role: string;
          cli_provider: string | null;
          oauth_account_id: string | null;
          api_provider_id: string | null;
          api_model: string | null;
          cli_model: string | null;
          cli_reasoning_level: string | null;
          personality: string | null;
          department_id: string | null;
          department_name: string | null;
          department_prompt: string | null;
          current_task_id: string | null;
          status: string;
        }
      | undefined;
    try {
      agent = db
        .prepare(
          `
      SELECT
        a.*,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.prompt, d.prompt) AS department_prompt
      FROM agents a
      LEFT JOIN tasks t ON t.id = a.current_task_id
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(t.workflow_pack_key, 'development')
       AND opd.department_id = a.department_id
      LEFT JOIN departments d ON d.id = a.department_id
      WHERE a.id = ?
    `,
        )
        .get(id) as
        | {
            id: string;
            name: string;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_prompt: string | null;
            current_task_id: string | null;
            status: string;
          }
        | undefined;
    } catch {
      agent = db
        .prepare(
          `
      SELECT a.*, d.name AS department_name, d.prompt AS department_prompt
      FROM agents a
      LEFT JOIN departments d ON d.id = a.department_id
      WHERE a.id = ?
    `,
        )
        .get(id) as
        | {
            id: string;
            name: string;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_prompt: string | null;
            current_task_id: string | null;
            status: string;
          }
        | undefined;
    }
    if (!agent) return res.status(404).json({ error: "not_found" });

    const provider = agent.cli_provider || "claude";
    if (!["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api"].includes(provider)) {
      return res.status(400).json({ error: "unsupported_provider", provider });
    }

    const taskId = agent.current_task_id;
    if (!taskId) {
      return res.status(400).json({ error: "no_task_assigned", message: "Assign a task to this agent first." });
    }

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          id: string;
          title: string;
          description: string | null;
          workflow_pack_key: string | null;
          project_id: string | null;
          department_id: string | null;
          project_path: string | null;
        }
      | undefined;
    if (!task) {
      return res.status(400).json({ error: "task_not_found" });
    }
    ensureVideoPreprodRemotionBestPracticesSkill({
      db: db as any,
      nowMs,
      workflowPackKey: task.workflow_pack_key,
      provider,
      taskId,
      appendTaskLog,
    });
    const taskLang = resolveLang(task.description ?? task.title);

    const projectPath = task.project_path || process.cwd();
    const worktreePath = createWorktree(projectPath, taskId, agent.name);
    if (!worktreePath) {
      appendTaskLog(
        taskId,
        "error",
        `Execution blocked: isolated worktree creation failed for project path '${projectPath}'`,
      );
      return res.status(409).json({
        error: "worktree_required",
        message: "Isolated worktree creation failed. Task execution was blocked to protect the project root.",
      });
    }
    const agentCwd = worktreePath;
    appendTaskLog(taskId, "system", `Git worktree created: ${worktreePath} (branch: climpire/${taskId.slice(0, 8)})`);
    if (provider === "claude") {
      ensureClaudeMd(projectPath, worktreePath);
    }
    const logPath = path.join(logsDir, `${taskId}.log`);
    const executionSession = ensureTaskExecutionSession(taskId, agent.id, provider);
    const availableSkillsPromptBlock = buildAvailableSkillsPromptBlock(provider);
    const roleLabel =
      { team_leader: "Team Leader", senior: "Senior", junior: "Junior", intern: "Intern" }[agent.role] || agent.role;
    const deptConstraint = agent.department_id
      ? getDeptRoleConstraint(agent.department_id, agent.department_name || agent.department_id)
      : "";
    const departmentPrompt = normalizeTextField(agent.department_prompt);
    const departmentPromptBlock = departmentPrompt ? `[Department Shared Prompt]\n${departmentPrompt}` : "";
    const videoArtifactSpec =
      task.workflow_pack_key === "video_preprod"
        ? resolveVideoArtifactSpecForTask(db as any, {
            project_id: task.project_id,
            project_path: task.project_path,
            department_id: task.department_id,
            workflow_pack_key: task.workflow_pack_key,
          })
        : null;
    const workflowPackGuidance = buildWorkflowPackExecutionGuidance(task.workflow_pack_key, taskLang, {
      videoArtifactRelativePath: videoArtifactSpec?.relativePath,
    });

    const prompt = buildTaskExecutionPrompt(
      [
        availableSkillsPromptBlock,
        `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
        "This session is scoped to this task only.",
        `[Task] ${task.title}`,
        task.description ? `\n${task.description}` : "",
        workflowPackGuidance ? `\n[Workflow Pack Execution Rules]\n${workflowPackGuidance}` : "",
        `NOTE: You are working in an isolated Git worktree branch (climpire/${taskId.slice(0, 8)}). Commit your changes normally.`,
        `Agent: ${agent.name} (${roleLabel}, ${agent.department_name || "Unassigned"})`,
        agent.personality ? `Personality: ${agent.personality}` : "",
        deptConstraint,
        departmentPromptBlock,
        pickL(
          l(
            ["위 작업을 충분히 완수하세요."],
            ["Please complete the task above thoroughly."],
            ["上記タスクを丁寧に完了してください。"],
            ["请完整地完成上述任务。"],
          ),
          taskLang,
        ),
      ],
      {
        allowWarningFix: hasExplicitWarningFixRequest(task.title, task.description),
      },
    );

    appendTaskLog(taskId, "system", `RUN start (agent=${agent.name}, provider=${provider})`);

    const spawnModelConfig = getProviderModelConfig();
    const spawnModel = agent.cli_model || spawnModelConfig[provider]?.model || undefined;
    const spawnReasoningLevel =
      provider === "codex"
        ? agent.cli_reasoning_level || spawnModelConfig[provider]?.reasoningLevel || undefined
        : spawnModelConfig[provider]?.reasoningLevel || undefined;

    if (provider === "api") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);
      db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(
        nowMs(),
        nowMs(),
        taskId,
      );
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
      broadcast("agent_status", updatedAgent);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyTaskStatus(taskId, task.title, "in_progress", taskLang);
      launchApiProviderAgent(
        taskId,
        agent.api_provider_id ?? null,
        agent.api_model ?? null,
        prompt,
        agentCwd,
        logPath,
        controller,
        fakePid,
      );
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd });
    }

    if (provider === "copilot" || provider === "antigravity") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);
      db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(
        nowMs(),
        nowMs(),
        taskId,
      );
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
      broadcast("agent_status", updatedAgent);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyTaskStatus(taskId, task.title, "in_progress", taskLang);
      launchHttpAgent(taskId, provider, prompt, agentCwd, logPath, controller, fakePid, agent.oauth_account_id ?? null);
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd });
    }

    const child = spawnCliAgent(taskId, provider, prompt, agentCwd, logPath, spawnModel, spawnReasoningLevel);
    child.on("close", (code: number | null) => {
      handleTaskRunComplete(taskId, code ?? 1);
    });

    db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);
    db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(
      nowMs(),
      nowMs(),
      taskId,
    );

    const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    broadcast("agent_status", updatedAgent);
    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    notifyTaskStatus(taskId, task.title, "in_progress", taskLang);

    res.json({ ok: true, pid: child.pid ?? null, logPath, cwd: agentCwd });
  });
}
