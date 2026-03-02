import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { MeetingReviewDecision } from "../../shared/types.ts";
import {
  DEFAULT_WORKFLOW_PACK_KEY,
  isWorkflowPackKey,
  type WorkflowPackKey,
} from "../../../workflow/packs/definitions.ts";
import { resolveConstrainedAgentScopeForTask } from "../tasks/execution-run-auto-assign.ts";
import { getDepartmentForPack, parseWorkflowPackKeyInput } from "../../../workflow/packs/department-scope.ts";

export function registerAgentCrudRoutes(ctx: RuntimeContext): void {
  const {
    app,
    db,
    broadcast,
    runInTransaction,
    nowMs,
    meetingPresenceUntil,
    meetingSeatIndexByAgent,
    meetingPhaseByAgent,
    meetingTaskIdByAgent,
    meetingReviewDecisionByAgent,
  } = ctx;
  const hasAgentWorkflowPackColumn = (() => {
    try {
      const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name?: unknown }>;
      return cols.some((col) => String(col.name ?? "").trim() === "workflow_pack_key");
    } catch {
      return false;
    }
  })();
  const agentPackExpr = hasAgentWorkflowPackColumn ? "COALESCE(a.workflow_pack_key, 'development')" : "'development'";

  function parseIncludeSeedParam(input: unknown): boolean {
    if (Array.isArray(input)) input = input[0];
    const raw = String(input ?? "")
      .trim()
      .toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  }

  function normalizeText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  function parseWorkflowPackKey(value: unknown): WorkflowPackKey | null {
    return parseWorkflowPackKeyInput(value);
  }

  function readActiveOfficeWorkflowPackKey(): WorkflowPackKey {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'officeWorkflowPack' LIMIT 1").get() as
      | { value?: unknown }
      | undefined;
    const parsed = parseWorkflowPackKey(row?.value);
    return parsed ?? DEFAULT_WORKFLOW_PACK_KEY;
  }

  function readNonDevelopmentProfileAgentIds(): Set<string> {
    const out = new Set<string>();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'officePackProfiles' LIMIT 1").get() as
      | { value?: unknown }
      | undefined;
    if (!row) return out;

    let root: unknown = row.value;
    if (typeof root === "string") {
      try {
        root = JSON.parse(root);
      } catch {
        return out;
      }
    }
    if (!root || typeof root !== "object" || Array.isArray(root)) return out;

    for (const [packKey, packProfileRaw] of Object.entries(root as Record<string, unknown>)) {
      if (!isWorkflowPackKey(packKey) || packKey === DEFAULT_WORKFLOW_PACK_KEY) continue;
      if (!packProfileRaw || typeof packProfileRaw !== "object" || Array.isArray(packProfileRaw)) continue;
      const packProfile = packProfileRaw as Record<string, unknown>;
      if (!Array.isArray(packProfile.agents)) continue;
      for (const rawAgent of packProfile.agents) {
        if (!rawAgent || typeof rawAgent !== "object" || Array.isArray(rawAgent)) continue;
        const agentId = normalizeText((rawAgent as Record<string, unknown>).id);
        if (agentId) out.add(agentId);
      }
    }
    return out;
  }

  function resolvePlanningLeaderScopeAgentIds(packKey: WorkflowPackKey): string[] {
    const constrained = resolveConstrainedAgentScopeForTask(db, {
      workflow_pack_key: packKey,
      department_id: "planning",
      project_id: null,
    });
    if (Array.isArray(constrained) && constrained.length > 0) {
      return Array.from(new Set(constrained.map((id) => normalizeText(id)).filter((id) => id.length > 0)));
    }

    if (packKey !== DEFAULT_WORKFLOW_PACK_KEY) {
      const prefixed = db.prepare("SELECT id FROM agents WHERE id LIKE ?").all(`${packKey}-%`) as Array<{
        id?: unknown;
      }>;
      return prefixed.map((row) => normalizeText(row.id)).filter((id): id is string => id.length > 0);
    }

    const excludeIds = [...readNonDevelopmentProfileAgentIds()];
    if (excludeIds.length > 0) {
      const placeholders = excludeIds.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT id FROM agents WHERE id NOT LIKE '%-seed-%' AND id NOT IN (${placeholders})`)
        .all(...(excludeIds as SQLInputValue[])) as Array<{ id?: unknown }>;
      return rows.map((row) => normalizeText(row.id)).filter((id): id is string => id.length > 0);
    }

    const rows = db.prepare("SELECT id FROM agents WHERE id NOT LIKE '%-seed-%'").all() as Array<{ id?: unknown }>;
    return rows.map((row) => normalizeText(row.id)).filter((id): id is string => id.length > 0);
  }

  function syncPlanningLeadFlagToPackProfile(params: {
    packKey: WorkflowPackKey;
    targetAgentId: string;
    enabled: boolean;
    scopeAgentIds: string[];
  }): void {
    const { packKey, targetAgentId, enabled, scopeAgentIds } = params;
    if (packKey === DEFAULT_WORKFLOW_PACK_KEY) return;

    const row = db.prepare("SELECT value FROM settings WHERE key = 'officePackProfiles' LIMIT 1").get() as
      | { value?: unknown }
      | undefined;
    if (!row) return;

    let root: unknown = row.value;
    if (typeof root === "string") {
      try {
        root = JSON.parse(root);
      } catch {
        return;
      }
    }
    if (!root || typeof root !== "object" || Array.isArray(root)) return;

    const rootObject = root as Record<string, unknown>;
    const packProfileRaw = rootObject[packKey];
    if (!packProfileRaw || typeof packProfileRaw !== "object" || Array.isArray(packProfileRaw)) return;
    const packProfile = packProfileRaw as Record<string, unknown>;
    if (!Array.isArray(packProfile.agents)) return;

    const scopeSet = new Set(scopeAgentIds.map((id) => normalizeText(id)).filter((id) => id.length > 0));
    let changed = false;
    const nextAgents = packProfile.agents.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const agent = entry as Record<string, unknown>;
      const agentId = normalizeText(agent.id);
      if (!agentId) return entry;

      const inScope = scopeSet.size > 0 ? scopeSet.has(agentId) : true;
      if (agentId !== targetAgentId && (!enabled || !inScope)) return entry;

      const current = Number(agent.acts_as_planning_leader ?? 0) > 0 ? 1 : 0;
      const next = agentId === targetAgentId ? (enabled ? 1 : 0) : 0;
      if (current === next) return entry;
      changed = true;
      return { ...agent, acts_as_planning_leader: next };
    });

    if (!changed) return;
    rootObject[packKey] = { ...packProfile, agents: nextAgents };
    const serialized = JSON.stringify(rootObject);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("officePackProfiles", serialized);
  }

  app.get("/api/agents", (req, res) => {
    const includeSeed = parseIncludeSeedParam(req.query?.include_seed);
    const seedFilterClause = includeSeed ? "" : "WHERE a.id NOT LIKE '%-seed-%'";
    let agents: unknown[];
    try {
      agents = db
        .prepare(
          `
      SELECT
        a.*,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.name_ko, d.name_ko) AS department_name_ko,
        COALESCE(opd.color, d.color) AS department_color
      FROM agents a
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = ${agentPackExpr}
       AND opd.department_id = a.department_id
      LEFT JOIN departments d ON a.department_id = d.id
      ${seedFilterClause}
      ORDER BY a.department_id, a.role, a.name
    `,
        )
        .all();
    } catch {
      agents = db
        .prepare(
          `
      SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
      FROM agents a
      LEFT JOIN departments d ON a.department_id = d.id
      ${seedFilterClause}
      ORDER BY a.department_id, a.role, a.name
    `,
        )
        .all();
    }
    res.json({ agents });
  });

  app.get("/api/meeting-presence", (_req, res) => {
    const now = nowMs();
    const presence: Array<{
      agent_id: string;
      seat_index: number;
      phase: "kickoff" | "review";
      task_id: string | null;
      decision: MeetingReviewDecision | null;
      until: number;
    }> = [];

    for (const [agentId, until] of meetingPresenceUntil.entries()) {
      if (until < now) {
        meetingPresenceUntil.delete(agentId);
        meetingSeatIndexByAgent.delete(agentId);
        meetingPhaseByAgent.delete(agentId);
        meetingTaskIdByAgent.delete(agentId);
        meetingReviewDecisionByAgent.delete(agentId);
        continue;
      }
      const phase = meetingPhaseByAgent.get(agentId) ?? "kickoff";
      presence.push({
        agent_id: agentId,
        seat_index: meetingSeatIndexByAgent.get(agentId) ?? 0,
        phase,
        task_id: meetingTaskIdByAgent.get(agentId) ?? null,
        decision: phase === "review" ? (meetingReviewDecisionByAgent.get(agentId) ?? "reviewing") : null,
        until,
      });
    }

    presence.sort((a, b) => a.seat_index - b.seat_index);
    res.json({ presence });
  });

  app.get("/api/agents/:id", (req, res) => {
    const id = String(req.params.id);
    let agent: unknown;
    try {
      agent = db
        .prepare(
          `
      SELECT
        a.*,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.name_ko, d.name_ko) AS department_name_ko,
        COALESCE(opd.color, d.color) AS department_color
      FROM agents a
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = ${agentPackExpr}
       AND opd.department_id = a.department_id
      LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
        )
        .get(id);
    } catch {
      agent = db
        .prepare(
          `
      SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
      FROM agents a
      LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
        )
        .get(id);
    }
    if (!agent) return res.status(404).json({ error: "not_found" });

    const recentTasks = db
      .prepare("SELECT * FROM tasks WHERE assigned_agent_id = ? ORDER BY updated_at DESC LIMIT 10")
      .all(id);

    res.json({ agent, recent_tasks: recentTasks });
  });

  app.post("/api/agents", (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const name_ko = typeof body.name_ko === "string" ? body.name_ko.trim() : "";
      const name_ja = typeof body.name_ja === "string" ? body.name_ja.trim() : "";
      const name_zh = typeof body.name_zh === "string" ? body.name_zh.trim() : "";
      if (!name) return res.status(400).json({ error: "name_required" });
      const requestedPackKey = parseWorkflowPackKey(body.workflow_pack_key);
      if (body.workflow_pack_key !== undefined && body.workflow_pack_key !== null && !requestedPackKey) {
        return res.status(400).json({ error: "invalid_workflow_pack_key" });
      }
      const activePackKey = readActiveOfficeWorkflowPackKey();
      const workflowPackKey = requestedPackKey ?? activePackKey;

      if (body.department_id !== undefined && body.department_id !== null && typeof body.department_id !== "string") {
        return res.status(400).json({ error: "invalid_department_id" });
      }
      const department_id = typeof body.department_id === "string" ? body.department_id.trim() || null : null;
      if (department_id) {
        const deptExists = getDepartmentForPack(db as any, workflowPackKey, department_id);
        if (!deptExists) return res.status(400).json({ error: "department_not_found" });
      }

      const role =
        typeof body.role === "string" && ["team_leader", "senior", "junior", "intern"].includes(body.role)
          ? body.role
          : "junior";
      const cli_provider =
        typeof body.cli_provider === "string" &&
        ["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api"].includes(body.cli_provider)
          ? body.cli_provider
          : "claude";
      const avatar_emoji =
        typeof body.avatar_emoji === "string" && body.avatar_emoji.trim() ? body.avatar_emoji.trim() : "🤖";
      const sprite_number =
        typeof body.sprite_number === "number" && body.sprite_number > 0 ? body.sprite_number : null;
      const personality = typeof body.personality === "string" ? body.personality.trim() || null : null;

      const id = randomUUID();
      try {
        if (hasAgentWorkflowPackColumn) {
          db.prepare(
            `INSERT INTO agents (id, name, name_ko, name_ja, name_zh, department_id, workflow_pack_key, role, cli_provider, avatar_emoji, sprite_number, personality)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            name,
            name_ko,
            name_ja,
            name_zh,
            department_id,
            workflowPackKey,
            role,
            cli_provider,
            avatar_emoji,
            sprite_number,
            personality,
          );
        } else {
          db.prepare(
            `INSERT INTO agents (id, name, name_ko, name_ja, name_zh, department_id, role, cli_provider, avatar_emoji, sprite_number, personality)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            name,
            name_ko,
            name_ja,
            name_zh,
            department_id,
            role,
            cli_provider,
            avatar_emoji,
            sprite_number,
            personality,
          );
        }
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (msg.includes("FOREIGN KEY constraint failed")) {
          return res.status(400).json({ error: "department_not_found" });
        }
        throw err;
      }

      let created: unknown;
      try {
        created = db
          .prepare(
            `
        SELECT
          a.*,
          COALESCE(opd.name, d.name) AS department_name,
          COALESCE(opd.name_ko, d.name_ko) AS department_name_ko,
          COALESCE(opd.color, d.color) AS department_color
        FROM agents a
        LEFT JOIN office_pack_departments opd
          ON opd.workflow_pack_key = ${agentPackExpr}
         AND opd.department_id = a.department_id
        LEFT JOIN departments d ON a.department_id = d.id
        WHERE a.id = ?
      `,
          )
          .get(id);
      } catch {
        created = db
          .prepare(
            `
        SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
        FROM agents a LEFT JOIN departments d ON a.department_id = d.id
        WHERE a.id = ?
      `,
          )
          .get(id);
      }
      broadcast("agent_created", created);
      res.status(201).json({ ok: true, agent: created });
    } catch (err) {
      console.error("[agents] POST failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.delete("/api/agents/:id", (req, res) => {
    try {
      const id = String(req.params.id);
      const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!existing) return res.status(404).json({ error: "not_found" });
      if (existing.status === "working") return res.status(400).json({ error: "cannot_delete_working_agent" });

      runInTransaction(() => {
        db.prepare("UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?").run(id);
        db.prepare("UPDATE subtasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?").run(id);
        db.prepare("UPDATE meeting_minute_entries SET speaker_agent_id = NULL WHERE speaker_agent_id = ?").run(id);
        db.prepare("UPDATE task_report_archives SET generated_by_agent_id = NULL WHERE generated_by_agent_id = ?").run(
          id,
        );
        db.prepare("UPDATE project_review_decision_states SET planner_agent_id = NULL WHERE planner_agent_id = ?").run(
          id,
        );
        db.prepare("UPDATE review_round_decision_states SET planner_agent_id = NULL WHERE planner_agent_id = ?").run(
          id,
        );
        db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      });

      broadcast("agent_deleted", { id });
      res.json({ ok: true, id });
    } catch (err) {
      console.error("[agents] DELETE failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.patch("/api/agents/:id", (req, res) => {
    const id = String(req.params.id);
    const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: "not_found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const nextProviderRaw = ("cli_provider" in body ? body.cli_provider : existing.cli_provider) as
      | string
      | null
      | undefined;
    const nextProvider = nextProviderRaw ?? "claude";
    const nextOAuthProvider =
      nextProvider === "copilot" ? "github" : nextProvider === "antigravity" ? "google_antigravity" : null;
    const supportsCliModelOverride = ["claude", "codex", "gemini", "opencode"].includes(nextProvider);
    const supportsCliReasoningOverride = nextProvider === "codex";
    const providerChanged = "cli_provider" in body && nextProvider !== String(existing.cli_provider ?? "claude");

    if (!nextOAuthProvider && !("oauth_account_id" in body) && "cli_provider" in body) {
      body.oauth_account_id = null;
    }
    if (nextProvider !== "api" && !("api_provider_id" in body) && "cli_provider" in body) {
      body.api_provider_id = null;
      body.api_model = null;
    }
    if ((!supportsCliModelOverride || providerChanged) && !("cli_model" in body)) {
      body.cli_model = null;
    }
    if ((!supportsCliReasoningOverride || providerChanged) && !("cli_reasoning_level" in body)) {
      body.cli_reasoning_level = null;
    }
    if ("cli_model" in body && !("cli_reasoning_level" in body) && supportsCliReasoningOverride) {
      body.cli_reasoning_level = null;
    }

    if ("oauth_account_id" in body) {
      if (body.oauth_account_id === "" || typeof body.oauth_account_id === "undefined") {
        body.oauth_account_id = null;
      }
      if (body.oauth_account_id !== null && typeof body.oauth_account_id !== "string") {
        return res.status(400).json({ error: "invalid_oauth_account_id" });
      }
      if (body.oauth_account_id && !nextOAuthProvider) {
        return res.status(400).json({ error: "oauth_account_requires_oauth_provider" });
      }
      if (body.oauth_account_id && nextOAuthProvider) {
        const oauthAccount = db
          .prepare("SELECT id, status FROM oauth_accounts WHERE id = ? AND provider = ?")
          .get(body.oauth_account_id, nextOAuthProvider) as { id: string; status: "active" | "disabled" } | undefined;
        if (!oauthAccount) {
          return res.status(400).json({ error: "oauth_account_not_found_for_provider" });
        }
        if (oauthAccount.status !== "active") {
          return res.status(400).json({ error: "oauth_account_disabled" });
        }
      }
    }

    if ("cli_model" in body) {
      if (body.cli_model === "" || typeof body.cli_model === "undefined") {
        body.cli_model = null;
      }
      if (body.cli_model !== null && typeof body.cli_model !== "string") {
        return res.status(400).json({ error: "invalid_cli_model" });
      }
      if (body.cli_model && !supportsCliModelOverride) {
        return res.status(400).json({ error: "cli_model_requires_cli_provider" });
      }
    }

    if ("cli_reasoning_level" in body) {
      if (body.cli_reasoning_level === "" || typeof body.cli_reasoning_level === "undefined") {
        body.cli_reasoning_level = null;
      }
      if (body.cli_reasoning_level !== null && typeof body.cli_reasoning_level !== "string") {
        return res.status(400).json({ error: "invalid_cli_reasoning_level" });
      }
      if (body.cli_reasoning_level && !supportsCliReasoningOverride) {
        return res.status(400).json({ error: "cli_reasoning_requires_codex_provider" });
      }
    }

    if ("acts_as_planning_leader" in body) {
      const raw = body.acts_as_planning_leader;
      if (raw === true || raw === 1 || raw === "1") {
        body.acts_as_planning_leader = 1;
      } else if (raw === false || raw === 0 || raw === "0" || raw === null || raw === "" || raw === undefined) {
        body.acts_as_planning_leader = 0;
      } else {
        return res.status(400).json({ error: "invalid_acts_as_planning_leader" });
      }
    }

    const requestedPackKey = parseWorkflowPackKey(body.workflow_pack_key);
    if ("workflow_pack_key" in body) {
      if (!requestedPackKey) {
        return res.status(400).json({ error: "invalid_workflow_pack_key" });
      }
      body.workflow_pack_key = requestedPackKey;
    }
    const existingPackKey = hasAgentWorkflowPackColumn ? parseWorkflowPackKey(existing.workflow_pack_key) : null;
    const officePackKey = requestedPackKey ?? existingPackKey ?? readActiveOfficeWorkflowPackKey();

    if ("department_id" in body) {
      if (body.department_id === "" || body.department_id === undefined) {
        body.department_id = null;
      } else if (body.department_id !== null && typeof body.department_id !== "string") {
        return res.status(400).json({ error: "invalid_department_id" });
      } else if (typeof body.department_id === "string") {
        const normalizedDepartmentId = body.department_id.trim();
        if (!normalizedDepartmentId) {
          body.department_id = null;
        } else {
          const deptExists = getDepartmentForPack(db as any, officePackKey, normalizedDepartmentId);
          if (!deptExists) return res.status(400).json({ error: "department_not_found" });
          body.department_id = normalizedDepartmentId;
        }
      }
    }

    const allowedFields = [
      "name",
      "name_ko",
      "name_ja",
      "name_zh",
      "department_id",
      ...(hasAgentWorkflowPackColumn ? (["workflow_pack_key"] as const) : []),
      "role",
      "cli_provider",
      "oauth_account_id",
      "api_provider_id",
      "api_model",
      "cli_model",
      "cli_reasoning_level",
      "avatar_emoji",
      "sprite_number",
      "personality",
      "status",
      "current_task_id",
      "acts_as_planning_leader",
    ];
    const forcePlanningLeadOverride =
      body.force_planning_leader_override === true ||
      body.force_planning_leader_override === 1 ||
      body.force_planning_leader_override === "1";
    const requestedPlanningLead = Number(body.acts_as_planning_leader ?? existing.acts_as_planning_leader ?? 0) === 1;
    let scopedAgentIds: string[] = [];

    if ("acts_as_planning_leader" in body && requestedPlanningLead) {
      try {
        scopedAgentIds = resolvePlanningLeaderScopeAgentIds(officePackKey);
        const conflictLeader = (() => {
          if (scopedAgentIds.length > 0) {
            const placeholders = scopedAgentIds.map(() => "?").join(", ");
            return db
              .prepare(
                `
                  SELECT id, name, name_ko
                  FROM agents
                  WHERE id IN (${placeholders})
                    AND role = 'team_leader'
                    AND COALESCE(acts_as_planning_leader, 0) = 1
                    AND id != ?
                  ORDER BY created_at ASC
                  LIMIT 1
                `,
              )
              .get(...([...scopedAgentIds, id] as SQLInputValue[])) as
              | { id?: unknown; name?: unknown; name_ko?: unknown }
              | undefined;
          }
          return db
            .prepare(
              `
                SELECT id, name, name_ko
                FROM agents
                WHERE role = 'team_leader'
                  AND COALESCE(acts_as_planning_leader, 0) = 1
                  AND id != ?
                ORDER BY created_at ASC
                LIMIT 1
              `,
            )
            .get(id) as { id?: unknown; name?: unknown; name_ko?: unknown } | undefined;
        })();

        if (conflictLeader && !forcePlanningLeadOverride) {
          return res.status(409).json({
            error: "planning_leader_exists",
            pack_key: officePackKey,
            existing_leader: {
              id: normalizeText(conflictLeader.id),
              name: normalizeText(conflictLeader.name),
              name_ko: normalizeText(conflictLeader.name_ko),
            },
          });
        }
      } catch (err: any) {
        const message = String(err?.message ?? err);
        if (message.includes("no such column: acts_as_planning_leader")) {
          return res.status(400).json({ error: "planning_leader_flag_not_available" });
        }
        console.error("[agents] planning leader conflict check failed:", err);
        return res.status(500).json({ error: "internal_error" });
      }
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    for (const field of allowedFields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        params.push(body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "no_fields_to_update" });
    }

    try {
      runInTransaction(() => {
        if ("acts_as_planning_leader" in body && requestedPlanningLead) {
          if (scopedAgentIds.length <= 0) {
            scopedAgentIds = resolvePlanningLeaderScopeAgentIds(officePackKey);
          }
          if (scopedAgentIds.length > 0) {
            const placeholders = scopedAgentIds.map(() => "?").join(", ");
            db.prepare(
              `
                UPDATE agents
                SET acts_as_planning_leader = 0
                WHERE id IN (${placeholders})
                  AND id != ?
                  AND COALESCE(acts_as_planning_leader, 0) = 1
              `,
            ).run(...([...scopedAgentIds, id] as SQLInputValue[]));
          } else {
            db.prepare(
              `
                UPDATE agents
                SET acts_as_planning_leader = 0
                WHERE id != ?
                  AND role = 'team_leader'
                  AND COALESCE(acts_as_planning_leader, 0) = 1
              `,
            ).run(id);
          }
        }

        params.push(id);
        db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...(params as SQLInputValue[]));

        if ("acts_as_planning_leader" in body) {
          syncPlanningLeadFlagToPackProfile({
            packKey: officePackKey,
            targetAgentId: id,
            enabled: requestedPlanningLead,
            scopeAgentIds: scopedAgentIds,
          });
        }
      });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (message.includes("no such column: acts_as_planning_leader")) {
        return res.status(400).json({ error: "planning_leader_flag_not_available" });
      }
      console.error("[agents] planning leader update failed:", err);
      return res.status(500).json({ error: "internal_error" });
    }

    const updated = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    broadcast("agent_status", updated);
    res.json({ ok: true, agent: updated });
  });
}
