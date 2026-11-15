import { createServer } from "node:http";
const port = Number(process.env.DEMO_PORT ?? 4321);
const html = (title) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title} · Demo Characterize</title><style>body{font:16px system-ui;max-width:760px;margin:70px auto;padding:20px;background:#f5f5ef;color:#344632}a{color:#466b3f}nav{display:flex;gap:24px;margin-bottom:35px}article{background:white;padding:24px;border:1px solid #dce3d5;border-radius:12px;margin:14px 0}button,input{font:inherit;padding:10px 14px;border:1px solid #c9d4bf;border-radius:6px}button{background:#456a3c;color:white;cursor:pointer}</style></head><body><nav><a href="/">Inicio</a><a href="/redirect">Catálogo</a><a href="/external">Ir al proveedor externo</a></nav><h1>${title}</h1>`;
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
      html("Catálogo") +
        '<label for="search">Buscar productos</label> <input id="search" placeholder="Buscar"><p id="count">2 productos</p><article data-product="Cuaderno"><h2>Cuaderno</h2><p>12 €</p><button>Añadir Cuaderno</button></article><article data-product="Lápiz"><h2>Lápiz</h2><p>3 €</p><button>Añadir Lápiz</button></article><p role="status">Carrito vacío</p><script>document.querySelector("#search").oninput=e=>{let count=0;document.querySelectorAll("article").forEach(a=>{a.hidden=!a.dataset.product.toLowerCase().includes(e.target.value.toLowerCase());if(!a.hidden)count++});document.querySelector("#count").textContent=count+" productos"};document.querySelectorAll("button").forEach(b=>b.onclick=()=>document.querySelector("[role=status]").textContent=b.textContent.replace("Añadir ","")+" añadido al carrito");</script></body></html>',
    );
  if (url.pathname === "/partner")
    return res.end(
      html("Proveedor externo") +
        "<p>Destino simulado en otro hostname. El recorrido termina aquí.</p></body></html>",
    );
  res.end(
    html("Una pequeña tienda de prueba") +
      '<p>Una web local para comprobar navegación, filtros, carrito y redirecciones sin datos reales.</p><article><h2>Descubre el catálogo</h2><p>Cuadernos y lápices para tus ideas.</p><a href="/redirect">Ver productos</a></article></body></html>',
  );
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Demo · http://127.0.0.1:${port}`),
);
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
