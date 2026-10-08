import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for https://example.com so smoke tests do not depend on live
 * third-party HTML (which changed and broke "Example Domain" / "Learn more").
 * Serves on an ephemeral 127.0.0.1 port; "Learn more" targets /more on the
 * same server so click-then-navigate flows stay local.
 */
const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Example Domain</title></head>
<body><div>
<h1>Example Domain</h1>
<p>This domain is for use in illustrative examples in documents.</p>
<p><a href="/more">Learn more</a></p>
</div></body></html>`;

const MORE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>More information</title></head>
<body><h1>More information</h1><p><a href="/">Back</a></p></body></html>`;

export interface ExampleFixture {
  url: string;
  close: () => Promise<void>;
}

export async function startExampleFixture(): Promise<ExampleFixture> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const body = path === "/" ? INDEX : path === "/more" ? MORE : null;
    if (body === null) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
