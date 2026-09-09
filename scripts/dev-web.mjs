// Dev server for the combined web build: the marketing site at `/` and the
// game at `/game/`, the same layout `scripts/build-web.mjs` writes to
// `site-dist/`. The game runs through Vite with hot module replacement; edits
// to the marketing site trigger a full reload.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import console from "node:console";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketingRoot = resolve(projectRoot, "marketing-site");
const gameBase = "/game/";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

// Mirrors the copy filter in scripts/build-web.mjs: the marketing site's own
// build output and its README never make it into the deployed site.
function isExcluded(pathFromMarketingRoot) {
  const [topLevelName] = pathFromMarketingRoot.split(sep);
  return topLevelName === "dist" || pathFromMarketingRoot === "README.md";
}

async function resolveMarketingFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const candidates = decoded.endsWith("/")
    ? [join(decoded, "index.html")]
    : [decoded, join(decoded, "index.html")];

  for (const candidate of candidates) {
    const absolutePath = resolve(marketingRoot, `.${candidate}`);
    const pathFromMarketingRoot = relative(marketingRoot, absolutePath);
    if (pathFromMarketingRoot.startsWith("..")) continue;
    if (pathFromMarketingRoot && isExcluded(pathFromMarketingRoot)) continue;

    const stats = await stat(absolutePath).catch(() => null);
    if (stats?.isFile()) return absolutePath;
  }

  return null;
}

function withViteClient(html) {
  const clientTag = `<script type="module" src="${gameBase}@vite/client"></script>`;
  return html.includes("</head>")
    ? html.replace(
        "</head>",
        `  ${clientTag}
  </head>`,
      )
    : clientTag + html;
}

const marketingSite = {
  name: "order-of-order:marketing-site-dev",
  configureServer(server) {
    // Registered from inside configureServer so it runs ahead of Vite's own
    // middlewares, which would otherwise answer `/` with the game's index.html.
    server.middlewares.use(async (req, res, next) => {
      if (!req.url || req.url.startsWith(gameBase)) {
        next();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        next();
        return;
      }

      // The deployed site does this with a `_redirects` rule.
      if (req.url === "/game" || req.url.startsWith("/game?")) {
        res.statusCode = 301;
        res.setHeader("Location", gameBase + req.url.slice("/game".length));
        res.end();
        return;
      }

      const filePath = await resolveMarketingFile(req.url);
      if (!filePath) {
        next();
        return;
      }

      const extension = extname(filePath).toLowerCase();
      res.setHeader(
        "Content-Type",
        MIME_TYPES[extension] ?? "application/octet-stream",
      );
      res.setHeader("Cache-Control", "no-cache");
      if (req.method === "HEAD") {
        res.end();
        return;
      }

      // The marketing pages are hand-written static HTML with no bundler
      // entry, so nothing on them speaks HMR until Vite's client is on the
      // page. With it, the watcher below can reload them on every edit.
      if (extension === ".html") {
        const html = await readFile(filePath, "utf8");
        res.end(withViteClient(html));
        return;
      }

      createReadStream(filePath).pipe(res);
    });

    server.watcher.add(marketingRoot);
    server.watcher.on("change", (changedPath) => {
      if (!resolve(changedPath).startsWith(marketingRoot + sep)) return;
      server.ws.send({ type: "full-reload", path: "*" });
    });
  },
};

const server = await createServer({
  configFile: resolve(projectRoot, "vite.config.ts"),
  root: projectRoot,
  base: gameBase,
  plugins: [marketingSite],
  server: { port: Number(process.env.PORT ?? 5174) },
});

await server.listen();
const { port } = server.config.server;
console.log(
  `\n  Combined site: http://localhost:${port}/ (marketing), http://localhost:${port}${gameBase} (game)\n`,
);
