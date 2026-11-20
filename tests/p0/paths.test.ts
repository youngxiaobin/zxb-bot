import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PathRejected, readFixture, writeDemoNote } from "@pa/runtime/paths";

test("fixture reads reject traversal and symlinks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fix-"));
  fs.writeFileSync(path.join(dir, "note.md"), "visible");
  fs.symlinkSync(path.join(dir, "note.md"), path.join(dir, "link.md"));
  assert.equal(readFixture(dir, "note.md").text, "visible");
  assert.throws(() => readFixture(dir, "../package.json"), PathRejected);
  assert.throws(
    () => readFixture(dir, "note.md/../../etc/passwd"),
    PathRejected,
  );
  assert.throws(() => readFixture(dir, "link.md"), PathRejected);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("demo write stays inside sandbox/notes and does not overwrite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-write-"));
  const runId = crypto.randomUUID();
  const written = writeDemoNote(dir, runId, "一次");
  assert.equal(fs.readFileSync(path.join(dir, written.path), "utf8"), "一次");
  assert.throws(() => writeDemoNote(dir, runId, "两次"), { code: "EEXIST" });
  assert.equal(fs.readFileSync(path.join(dir, written.path), "utf8"), "一次");
  fs.rmSync(dir, { recursive: true, force: true });
});
