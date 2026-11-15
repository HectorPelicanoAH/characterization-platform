import { createServer } from "node:http";
const port = Number(process.env.DEMO_PORT ?? 4321);
const html = (title) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · Demo Characterize</title><style>body{font:16px system-ui;max-width:760px;margin:70px auto;padding:20px;background:#f5f5ef;color:#344632}a{color:#466b3f}nav{display:flex;gap:24px;margin-bottom:35px}article{background:white;padding:24px;border:1px solid #dce3d5;border-radius:12px;margin:14px 0}button,input{font:inherit;padding:10px 14px;border:1px solid #c9d4bf;border-radius:6px}button{background:#456a3c;color:white;cursor:pointer}</style></head><body><nav><a href="/">Home</a><a href="/redirect">Catalog</a><a href="/external">Visit external supplier</a></nav><h1>${title}</h1>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/redirect") {
    res.writeHead(302, { Location: "/catalog" });
    return res.end();
  }
  if (url.pathname === "/external") {
    res.writeHead(302, { Location: `http://localhost:${port}/partner` });
    return res.end();
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/catalog")
    return res.end(
      html("Catalog") +
        '<label for="search">Search products</label> <input id="search" placeholder="Search"><p id="count">2 products</p><article data-product="Notebook"><h2>Notebook</h2><p>12 €</p><button>Add Notebook</button></article><article data-product="Pencil"><h2>Pencil</h2><p>3 €</p><button>Add Pencil</button></article><p role="status">Cart is empty</p><script>document.querySelector("#search").oninput=e=>{let count=0;document.querySelectorAll("article").forEach(a=>{a.hidden=!a.dataset.product.toLowerCase().includes(e.target.value.toLowerCase());if(!a.hidden)count++});document.querySelector("#count").textContent=count+" products"};document.querySelectorAll("button").forEach(b=>b.onclick=()=>document.querySelector("[role=status]").textContent=b.textContent.replace("Add ","")+" added to cart");</script></body></html>',
    );
  if (url.pathname === "/partner")
    return res.end(
      html("External supplier") +
        "<p>This simulated supplier uses a different hostname. The journey ends here.</p></body></html>",
    );
  res.end(
    html("Stationery shop") +
      '<p>Explore navigation, filters, cart updates and redirects using sample products.</p><article><h2>Browse the catalog</h2><p>Notebooks and pencils for your next project.</p><a href="/redirect">View products</a></article></body></html>',
  );
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Demo · http://127.0.0.1:${port}`),
);
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
