// Renders real loop pages from the sample log into static files for screenshots.
import { readFile, writeFile } from "node:fs/promises";
import { loopPage } from "../../../src/pages.mjs";

const read = async (f) => JSON.parse(await readFile(new URL(`../../../seed/${f}`, import.meta.url), "utf8"));
const state = { meta: await read("log.json"), loops: await read("loops.json"), experiments: await read("experiments.json") };
const pub = new URL("../../../public/", import.meta.url).href;

const withExp = state.experiments.flatMap((e) => e.loops);
const codes = [...new Set([...withExp, state.loops.find((l) => l.level === "unmapped")?.code, state.loops.find((l) => l.code.startsWith("R-PAR"))?.code])].filter(Boolean);
console.log("codes", codes.join(" "));

for (const [code, owner] of [[process.argv[2] || withExp[0], true], [process.argv[2] || withExp[0], false], [codes.find((c) => c.startsWith("R-PAR")), false]]) {
  if (!code) continue;
  const html = loopPage({ state, owner, code, connected: true, url: new URL(`https://log.example.com/loop/${code}`) })
    .replaceAll('href="/app.css"', `href="${pub}app.css"`)
    .replaceAll('src="/app.js"', `src="${pub}app.js"`)
    .replaceAll('src="/', `src="${pub}`);
  await writeFile(new URL(`real-${code}-${owner ? "owner" : "public"}.html`, import.meta.url), html);
}
