// Tiny local server for the brand studio: serves brand/ and saves PNGs the
// studio page renders (POST /save?name=file.png with a data URL body).
// Usage: node scripts/brand/server.mjs   then open http://localhost:3299/studio/
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../../brand", import.meta.url).pathname);
const out = path.join(root, "export");
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/save") {
    const name = url.searchParams.get("name") || "";
    if (!/^[a-z0-9-]+\.png$/.test(name)) return res.writeHead(400).end("bad name");
    let body = "";
    for await (const c of req) body += c;
    writeFileSync(path.join(out, name), Buffer.from(body.replace(/^data:image\/png;base64,/, ""), "base64"));
    console.log("saved", name);
    return res.writeHead(200).end("ok");
  }
  let p = path.join(root, decodeURIComponent(url.pathname));
  if (p.endsWith("/")) p = path.join(p, "index.html");
  if (!p.startsWith(root) || !existsSync(p)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
}).listen(3299, () => console.log("brand studio on http://localhost:3299/studio/"));
