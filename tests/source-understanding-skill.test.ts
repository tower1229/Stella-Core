import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("source understanding is model-visible through existing plugin skills and respects Host selection", async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-source-skill-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, "workspace"); await mkdir(workspace);
  const root = process.cwd();
  // Same public, no-start discovery used by the existing continuation test.
  // An empty synthetic HOME/state keeps user skills, histories and credentials out.
  const script = `
    import { listSkillCommandsForWorkspace } from "openclaw/plugin-sdk/skill-commands-runtime";
    const base = {workspaceDir:${JSON.stringify(workspace)},agentId:"main"};
    const cfg = {agents:{defaults:{workspace:base.workspaceDir}},plugins:{enabled:true,
      allow:["stella-core"],load:{paths:[${JSON.stringify(root)}]},entries:{"stella-core":{enabled:true}}}};
    const selected = x => x.filter(s => s.skillName === "stella-understand-sources");
    const enabled = selected(listSkillCommandsForWorkspace({...base,cfg}));
    const explicit = selected(listSkillCommandsForWorkspace({...base,cfg,skillFilter:["stella-understand-sources"]}));
    const disabled = selected(listSkillCommandsForWorkspace({...base,cfg:{...cfg,
      plugins:{...cfg.plugins,entries:{"stella-core":{enabled:false}}}}}));
    const hidden = selected(listSkillCommandsForWorkspace({...base,cfg,skillFilter:["stella-continue"]}));
    console.log(JSON.stringify({enabled,explicit,disabled,hidden}));
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, timeout: 30_000, env: { HOME: home, PATH: process.env.PATH,
      TMPDIR: home, OPENCLAW_STATE_DIR: path.join(home, "state"),
      OPENCLAW_CONFIG_PATH: path.join(home, "config.json"),
      OPENCLAW_BUNDLED_SKILLS_DIR: path.join(home, "empty-bundled") },
  });
  const found = JSON.parse(stdout.trim());
  assert.equal(found.enabled.length, 1);
  assert.equal(found.enabled[0].modelVisible, true);
  assert.equal(found.enabled[0].skillFile, path.join(root, "skills/stella-understand-sources/SKILL.md"));
  assert.equal(found.enabled[0].dispatch, undefined); // native model loop, not a new runner
  assert.equal(found.explicit.length, 1);
  assert.deepEqual(found.disabled, []);
  assert.deepEqual(found.hidden, []);
});
