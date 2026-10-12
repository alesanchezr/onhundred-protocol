// Lets render.mjs import src/ in plain Node: cloudflare:workers becomes an empty stub.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s, c, next) { return s.startsWith("cloudflare:") ? { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true } : next(s, c); }`
    )
);
