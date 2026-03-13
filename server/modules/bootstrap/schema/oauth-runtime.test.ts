import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./base-schema";
import { initializeOAuthRuntime } from "./oauth-runtime";

describe("initializeOAuthRuntime", () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("upgrades legacy provider checks to include kimi for agents and skill history", () => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE oauth_credentials (
        id TEXT PRIMARY KEY,
        provider TEXT,
        source TEXT,
        email TEXT,
        scope TEXT,
        expires_at INTEGER,
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        created_at INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      );
      CREATE TABLE oauth_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source TEXT,
        label TEXT,
        email TEXT,
        scope TEXT,
        expires_at INTEGER,
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        model_override TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        priority INTEGER NOT NULL DEFAULT 100,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_at INTEGER,
        last_success_at INTEGER,
        created_at INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      );
      CREATE TABLE oauth_active_accounts (
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        updated_at INTEGER DEFAULT 0,
        PRIMARY KEY (provider, account_id)
      );
      CREATE TABLE departments (
        id TEXT PRIMARY KEY,
        sort_order INTEGER
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_ko TEXT NOT NULL DEFAULT '',
        name_ja TEXT NOT NULL DEFAULT '',
        name_zh TEXT NOT NULL DEFAULT '',
        department_id TEXT REFERENCES departments(id),
        workflow_pack_key TEXT NOT NULL DEFAULT 'development',
        role TEXT NOT NULL CHECK(role IN ('team_leader','senior','junior','intern')),
        acts_as_planning_leader INTEGER NOT NULL DEFAULT 0 CHECK(acts_as_planning_leader IN (0,1)),
        cli_provider TEXT CHECK(cli_provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api')),
        oauth_account_id TEXT,
        api_provider_id TEXT,
        api_model TEXT,
        cli_model TEXT,
        cli_reasoning_level TEXT,
        avatar_emoji TEXT NOT NULL DEFAULT '🤖',
        sprite_number INTEGER,
        personality TEXT,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','working','break','offline')),
        current_task_id TEXT,
        stats_tasks_done INTEGER DEFAULT 0,
        stats_xp INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT 0
      );
      CREATE TABLE skill_learning_history (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api')),
        repo TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
        command TEXT NOT NULL,
        error TEXT,
        run_started_at INTEGER,
        run_completed_at INTEGER,
        created_at INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0,
        UNIQUE(job_id, provider)
      );
    `);

    initializeOAuthRuntime({
      db,
      nowMs: () => 0,
      runInTransaction: (fn) => fn(),
    });

    const agentSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get() as {
        sql: string;
      }
    ).sql;
    const historySql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_learning_history'").get() as {
        sql: string;
      }
    ).sql;

    expect(agentSql).toContain("'kimi'");
    expect(historySql).toContain("'kimi'");
  });

  it("upgrades legacy agents without workflow_pack_key before task migrations run", () => {
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    db.exec(`
      DROP TABLE agents;
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_ko TEXT NOT NULL DEFAULT '',
        name_ja TEXT NOT NULL DEFAULT '',
        name_zh TEXT NOT NULL DEFAULT '',
        department_id TEXT REFERENCES departments(id),
        role TEXT NOT NULL CHECK(role IN ('team_leader','senior','junior','intern')),
        acts_as_planning_leader INTEGER NOT NULL DEFAULT 0 CHECK(acts_as_planning_leader IN (0,1)),
        cli_provider TEXT CHECK(cli_provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api')),
        oauth_account_id TEXT,
        api_provider_id TEXT,
        api_model TEXT,
        cli_model TEXT,
        cli_reasoning_level TEXT,
        avatar_emoji TEXT NOT NULL DEFAULT '🤖',
        sprite_number INTEGER,
        personality TEXT,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','working','break','offline')),
        current_task_id TEXT,
        stats_tasks_done INTEGER DEFAULT 0,
        stats_xp INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT 0
      );
      INSERT INTO agents (id, name, role, cli_provider, created_at)
      VALUES ('legacy-agent', 'Legacy Agent', 'junior', 'claude', 123);

      DROP TABLE skill_learning_history;
      CREATE TABLE skill_learning_history (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api')),
        repo TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
        command TEXT NOT NULL,
        error TEXT,
        run_started_at INTEGER,
        run_completed_at INTEGER,
        created_at INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0,
        UNIQUE(job_id, provider)
      );
      INSERT INTO skill_learning_history (id, job_id, provider, repo, skill_id, skill_label, status, command)
      VALUES ('history-1', 'job-1', 'claude', 'repo', 'skill', 'Skill', 'queued', 'echo test');
    `);

    let transactionRuns = 0;
    initializeOAuthRuntime({
      db,
      nowMs: () => 0,
      runInTransaction: (fn) => {
        transactionRuns += 1;
        db!.exec("BEGIN");
        try {
          fn();
          db!.exec("COMMIT");
        } catch (error) {
          db!.exec("ROLLBACK");
          throw error;
        }
      },
    });

    const agentSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get() as {
        sql: string;
      }
    ).sql;
    const historySql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_learning_history'").get() as {
        sql: string;
      }
    ).sql;
    const row = db
      .prepare("SELECT workflow_pack_key, cli_provider, created_at FROM agents WHERE id = ?")
      .get("legacy-agent") as {
      workflow_pack_key: string;
      cli_provider: string;
      created_at: number;
    };

    expect(transactionRuns).toBeGreaterThan(0);
    expect(agentSql).toContain("workflow_pack_key");
    expect(agentSql).toContain("'kimi'");
    expect(historySql).toContain("'kimi'");
    expect(row).toEqual({
      workflow_pack_key: "development",
      cli_provider: "claude",
      created_at: 123,
    });
  });
});
