import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  loadConfig,
  validateProfileName,
  readConfigFile,
  saveConfigFile,
  deleteConfigFile,
  listProfiles,
  getDefaultProfile,
  createProfile,
  deleteProfile,
  resetProfile,
  setDefaultProfile,
  saveProfileConfig,
  DEFAULTS,
  DEFAULT_PROFILE,
  type ConfigFileData,
} from "./config.js";
import { tmpConfigDir, cleanupDir } from "./test-utils.js";

// ---------------------------------------------------------------------------
// validateProfileName
// ---------------------------------------------------------------------------

test("validateProfileName accepts valid names", () => {
  validateProfileName("default");
  validateProfileName("my-profile");
  validateProfileName("coding_123");
  validateProfileName("A");
});

test("validateProfileName rejects invalid names", () => {
  assert.throws(() => validateProfileName(""), /Invalid profile name/);
  assert.throws(() => validateProfileName("has space"), /Invalid profile name/);
  assert.throws(() => validateProfileName("../traversal"), /Invalid profile name/);
  assert.throws(() => validateProfileName("a/b"), /Invalid profile name/);
});

// ---------------------------------------------------------------------------
// loadConfig defaults
// ---------------------------------------------------------------------------

test("loadConfig returns sensible defaults with no config file", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));
  const cfg = loadConfig({ configPath });

  assert.equal(cfg.chunkSize, DEFAULTS.chunkSize);
  assert.equal(cfg.tokenMax, DEFAULTS.tokenMax);
  assert.equal(cfg.sessionDays, DEFAULTS.sessionDays);
  assert.equal(cfg.sessionMax, DEFAULTS.sessionMax);
  assert.equal(cfg.ftsWeight, DEFAULTS.ftsWeight);
  assert.equal(cfg.minScore, DEFAULTS.minScore);
  assert.equal(cfg.maxResults, DEFAULTS.maxResults);
  assert.equal(cfg.model, DEFAULTS.model);
});

// ---------------------------------------------------------------------------
// loadConfig — ftsWeight / minScore / maxResults clamping
// ---------------------------------------------------------------------------

test("loadConfig clamps ftsWeight to [0, 1]", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  saveConfigFile({ profiles: { default: { ftsWeight: -0.5 } } }, configPath);
  assert.equal(loadConfig({ configPath }).ftsWeight, 0);

  saveConfigFile({ profiles: { default: { ftsWeight: 1.5 } } }, configPath);
  assert.equal(loadConfig({ configPath }).ftsWeight, 1);

  saveConfigFile({ profiles: { default: { ftsWeight: 0.7 } } }, configPath);
  assert.equal(loadConfig({ configPath }).ftsWeight, 0.7);
});

test("loadConfig clamps minScore to [0, 1]", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  saveConfigFile({ profiles: { default: { minScore: -1 } } }, configPath);
  assert.equal(loadConfig({ configPath }).minScore, 0);

  saveConfigFile({ profiles: { default: { minScore: 5 } } }, configPath);
  assert.equal(loadConfig({ configPath }).minScore, 1);
});

test("loadConfig clamps maxResults to [1, 100] and rounds to integer", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  saveConfigFile({ profiles: { default: { maxResults: 0 } } }, configPath);
  assert.equal(loadConfig({ configPath }).maxResults, 1);

  saveConfigFile({ profiles: { default: { maxResults: 200 } } }, configPath);
  assert.equal(loadConfig({ configPath }).maxResults, 100);

  saveConfigFile({ profiles: { default: { maxResults: 5.7 } } }, configPath);
  assert.equal(loadConfig({ configPath }).maxResults, 6); // Math.round
});

test("loadConfig falls back to defaults for non-finite values", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  fs.writeFileSync(configPath, JSON.stringify({
    profiles: { default: { ftsWeight: "not-a-number", maxResults: null } },
  }));
  const cfg = loadConfig({ configPath });
  assert.equal(cfg.ftsWeight, DEFAULTS.ftsWeight);
  assert.equal(cfg.maxResults, DEFAULTS.maxResults);
});

// ---------------------------------------------------------------------------
// loadConfig — overrides take priority
// ---------------------------------------------------------------------------

test("loadConfig overrides beat config file values", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  saveConfigFile({ profiles: { default: { ftsWeight: 0.3, maxResults: 20 } } }, configPath);
  const cfg = loadConfig({
    configPath,
    overrides: { ftsWeight: 0.8, maxResults: 5 },
  });
  assert.equal(cfg.ftsWeight, 0.8);
  assert.equal(cfg.maxResults, 5);
});

test("loadConfig overrides are also clamped", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  const cfg = loadConfig({
    configPath,
    overrides: { ftsWeight: 2, maxResults: -10, minScore: 5 },
  });
  assert.equal(cfg.ftsWeight, 1);
  assert.equal(cfg.maxResults, 1);
  assert.equal(cfg.minScore, 1);
});

// ---------------------------------------------------------------------------
// loadConfig — chunkSize / tokenMax clamping
// ---------------------------------------------------------------------------

test("loadConfig clamps chunkSize and tokenMax", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  saveConfigFile({ profiles: { default: { chunkSize: 10, tokenMax: 50 } } }, configPath);
  const cfg = loadConfig({ configPath });
  assert.equal(cfg.chunkSize, 64);   // min 64
  assert.equal(cfg.tokenMax, 100);   // min 100

  saveConfigFile({ profiles: { default: { chunkSize: 99999, tokenMax: 99999 } } }, configPath);
  const cfg2 = loadConfig({ configPath });
  assert.equal(cfg2.chunkSize, 4096);  // max 4096
  assert.equal(cfg2.tokenMax, 16384);  // max 16384
});

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

test("profile CRUD operations", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  let profiles = listProfiles(configPath);
  assert.ok(profiles.includes(DEFAULT_PROFILE));

  assert.equal(createProfile("test-profile", configPath), true);
  profiles = listProfiles(configPath);
  assert.ok(profiles.includes("test-profile"));

  assert.equal(createProfile("test-profile", configPath), false);

  saveProfileConfig("test-profile", { ftsWeight: 0.8 }, configPath);
  const cfg = loadConfig({ profile: "test-profile", configPath });
  assert.equal(cfg.ftsWeight, 0.8);

  assert.equal(setDefaultProfile("test-profile", configPath), true);
  assert.equal(getDefaultProfile(configPath), "test-profile");

  assert.equal(resetProfile("test-profile", configPath), true);
  const cfgAfterReset = loadConfig({ profile: "test-profile", configPath });
  assert.equal(cfgAfterReset.ftsWeight, DEFAULTS.ftsWeight);

  assert.equal(deleteProfile("test-profile", configPath), true);
  profiles = listProfiles(configPath);
  assert.ok(!profiles.includes("test-profile"));
});

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

test("readConfigFile returns empty object for missing file", () => {
  const data = readConfigFile("/nonexistent/path/config.json");
  assert.deepEqual(data, {});
});

test("saveConfigFile + readConfigFile roundtrip", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  const data: ConfigFileData = {
    defaultProfile: "coding",
    profiles: {
      coding: { ftsWeight: 0.7, maxResults: 20 },
    },
  };
  saveConfigFile(data, configPath);
  const loaded = readConfigFile(configPath);
  assert.equal(loaded.defaultProfile, "coding");
  assert.equal(loaded.profiles?.coding?.ftsWeight, 0.7);
  assert.equal(loaded.profiles?.coding?.maxResults, 20);
});

test("deleteConfigFile removes file", (t) => {
  const { dir, configPath } = tmpConfigDir();
  t.after(() => cleanupDir(dir));

  saveConfigFile({ defaultProfile: "test" }, configPath);
  assert.ok(fs.existsSync(configPath));

  assert.equal(deleteConfigFile(configPath), true);
  assert.ok(!fs.existsSync(configPath));

  assert.equal(deleteConfigFile(configPath), false);
});
