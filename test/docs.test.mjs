import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DOCS_MODULE, docsModule } from "../scripts/build-docs.mjs";

test("src/docs.mjs matches docs/ and the protocol version", async () => {
  assert.equal(await readFile(DOCS_MODULE, "utf8"), await docsModule(), "run npm run docs");
});
