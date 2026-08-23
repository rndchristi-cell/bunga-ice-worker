const ORDER_CODE_REGEX = /BIS-\d{6}-[A-Z0-9]{4}/;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
  return new Response(null, { headers: corsHeaders });
}

const url = new URL(request.url);
if (request.method === "GET" && url.pathname === "/admin") {
  return handleAdminDashboard(request, env);
}

if (url.pathname === "/api/catalog" && request.method === "GET") {
  return handleCatalog(env, corsHeaders);
}

if (url.pathname.startsWith("/media/") && request.method === "GET") {
  return handleMedia(request, env);
}

if (url.pathname.startsWith("/api/admin/")) {
  return handleAdminApi(request, env, corsHeaders, url);
}

if (request.method !== "POST") {
  return new Response("Method not allowed", { status: 405, headers: corsHeaders });
}

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
    }

    if (body.message) {
      await handleTelegramUpdate(body, env);
      return new Response("OK", { headers: corsHeaders });
    }

    if (body.orderCode) {
      return handleNewOrder(body, env, corsHeaders);
    }

    return new Response("Unrecognized payload", { status: 400, headers: corsHeaders });
  },
};

async function handleCatalog(env, corsHeaders) {
  if (!env.BUNGA_ICE_DB) {
    return jsonResponse({ success: false, error: "D1 belum terpasang" }, 503, corsHeaders);
  }
  const products = await env.BUNGA_ICE_DB.prepare(`
    SELECT p.id, p.name, p.slug, p.description, p.base_price AS harga,
           p.is_available AS tersedia, p.is_active AS aktif, p.sort_order,
           c.name AS kategori
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = 1 AND p.is_available = 1
    ORDER BY p.sort_order, p.name
  `).all();
  const groups = await env.BUNGA_ICE_DB.prepare(`
    SELECT vg.id AS group_id, vg.product_id, vg.name AS grup,
           vg.input_type AS tipe, vg.is_required AS wajib,
           v.id AS id_varian, v.name AS nama_varian,
           v.price_delta AS tambah_harga
    FROM variant_groups vg
    LEFT JOIN variants v ON v.group_id = vg.id AND v.is_active = 1
    WHERE vg.is_active = 1
    ORDER BY vg.product_id, vg.sort_order, v.sort_order
  `).all();
  const images = await env.BUNGA_ICE_DB.prepare(`
    SELECT product_id, object_key, alt_text, sort_order
    FROM product_images WHERE is_active = 1
    ORDER BY product_id, sort_order
  `).all();
  const imageMap = {};
  for (const image of images.results || []) {
    (imageMap[image.product_id] ||= []).push(`/media/${encodeURIComponent(image.object_key)}`);
  }
  const variantMap = {};
  for (const row of groups.results || []) {
    const product = (variantMap[row.product_id] ||= {});
    const list = (product[row.grup] ||= []);
    if (row.id_varian) list.push({
      id_varian: row.id_varian,
      nama_varian: row.nama_varian,
      tambah_harga: Number(row.tambah_harga || 0),
      aktif: true,
      wajib: Boolean(row.wajib),
      tipe: row.tipe,
    });
  }
  return jsonResponse({
    produk: (products.results || []).map((p) => ({
      id: p.id, nama: p.name, harga: Number(p.harga), foto: imageMap[p.id] || [],
      deskripsi: p.description, aktif: Boolean(p.aktif), tersedia: Boolean(p.tersedia),
      kategori: p.kategori || "Menu",
    })),
    varian: variantMap,
    config: { toko: "Bunga Ice and Snack" },
  }, 200, corsHeaders);
}

async function handleMedia(request, env) {
  if (!env.BUNGA_ICE_ASSETS) return new Response("R2 belum terpasang", { status: 503 });
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.slice("/media/".length));
  if (!key || key.includes("..")) return new Response("Invalid asset key", { status: 400 });
  const object = await env.BUNGA_ICE_ASSETS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

function adminAuthorized(request, env) {
  const auth = request.headers.get("Authorization");
  return Boolean(auth && env.ADMIN_PASSWORD && checkAuth(auth, env.ADMIN_PASSWORD));
}

async function handleAdminApi(request, env, corsHeaders, url) {
  if (!adminAuthorized(request, env)) return jsonResponse({ success: false, error: "Auth required" }, 401, { ...corsHeaders, "WWW-Authenticate": 'Basic realm="Bunga Ice Admin"' });
  if (!env.BUNGA_ICE_DB) return jsonResponse({ success: false, error: "D1 belum terpasang" }, 503, corsHeaders);
  if (url.pathname === "/api/admin/products" && request.method === "GET") {
    const data = await env.BUNGA_ICE_DB.prepare(`SELECT id, name, description, base_price, is_active, is_available, sort_order FROM products ORDER BY sort_order, name`).all();
    return jsonResponse({ products: data.results || [] }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/products" && request.method === "PUT") {
    const body = await request.json();
    if (!body.id || !body.name || !Number.isFinite(Number(body.base_price))) return jsonResponse({ success: false, error: "id, name, dan base_price wajib diisi" }, 400, corsHeaders);
    await env.BUNGA_ICE_DB.prepare(`UPDATE products SET name = ?, description = ?, base_price = ?, is_active = ?, is_available = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`).bind(String(body.name).trim(), String(body.description || "").trim(), Math.max(0, Math.round(Number(body.base_price))), body.is_active === false ? 0 : 1, body.is_available === false ? 0 : 1, Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0, String(body.id)).run();
    return jsonResponse({ success: true }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/upload" && request.method === "POST") {
    if (!env.BUNGA_ICE_ASSETS) return jsonResponse({ success: false, error: "R2 belum terpasang" }, 503, corsHeaders);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonResponse({ success: false, error: "file wajib diisi" }, 400, corsHeaders);
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) return jsonResponse({ success: false, error: "File harus gambar maksimal 5MB" }, 400, corsHeaders);
    const safeName = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const key = `products/${crypto.randomUUID()}-${safeName}`;
    await env.BUNGA_ICE_ASSETS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    return jsonResponse({ success: true, object_key: key, url: `/media/${encodeURIComponent(key)}` }, 201, corsHeaders);
  }
  return jsonResponse({ success: false, error: "Admin route tidak ditemukan" }, 404, corsHeaders);
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

async function handleNewOrder(order, env, corsHeaders) {
  try {
    const itemsText = order.items
      .map((item) => {
        const varian = item.varianTerpilih.map((v) => v.nama_varian).join(", ");
        const namaLengkap = varian ? `${item.namaProduk} (${varian})` : item.namaProduk;
        const subtotal = item.hargaSatuan * item.qty;
        return `• ${item.qty}x ${namaLengkap} - Rp${subtotal.toLocaleString("id-ID")}`;
      })
      .join("\n");

    const ambilText = order.ambil === "hari_ini" ? "Hari ini" : "Besok";

    let message =
      `🛍️ Order Baru!\n\n` +
      `Kode: ${order.orderCode}\n\n` +
      `${itemsText}\n\n` +
      `Total: Rp${Number(order.total).toLocaleString("id-ID")}\n` +
      `Ambil: ${ambilText}, jam ${order.jamAmbil}`;

    if (order.namaPemesan) {
      message += `\nNama: ${order.namaPemesan}`;
    }
    if (order.noHp) {
      message += `\nHP: ${order.noHp}`;
    }
    if (order.catatan) {
      message += `\nCatatan: ${order.catatan}`;
    }

    message += `\n\nMenunggu bukti pembayaran dari customer.`;

    await sendTelegramMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, message);

    await env.BUNGA_ICE_ORDERS.put(
      `order:${order.orderCode}`,
      JSON.stringify({ status: "menunggu_bukti", chatId: null, order })
    );

    return new Response(
      JSON.stringify({ success: true, orderCode: order.orderCode }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
} catch (err) {
  console.log("ERROR DI HANDLENEWORDER:", err.message);
  return new Response(
    JSON.stringify({ success: false, error: err.message }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
}

async function handleTelegramUpdate(body, env) {
  const message = body.message;
  const chatId = message.chat.id;
  const text = message.text || message.caption || "";

  if (text.trim() === "/id") {
    await sendTelegramMessage(
      env,
      chatId,
      `Chat ID kamu: ${chatId}\nENV admin: ${env.TELEGRAM_ADMIN_CHAT_ID}\nMatch: ${String(chatId) === String(env.TELEGRAM_ADMIN_CHAT_ID)}`
    );
    return;
  }

  const isAdmin = String(chatId) === String(env.TELEGRAM_ADMIN_CHAT_ID);

  if (isAdmin) {
    await handleAdminReply(text, env);
    return;
  }

  const match = text.match(ORDER_CODE_REGEX);
  if (!match) {
    await sendTelegramMessage(
      env,
      chatId,
      "Mohon sebutkan kode pesanan kamu (format BIS-XXXXXX-XXXX) saat kirim bukti bayar ya 🙏"
    );
    return;
  }

  const orderCode = match[0];
  const dataRaw = await env.BUNGA_ICE_ORDERS.get(`order:${orderCode}`);

  if (!dataRaw) {
    await sendTelegramMessage(env, chatId, `Kode pesanan ${orderCode} nggak ketemu. Coba cek lagi ya.`);
    return;
  }

  const data = JSON.parse(dataRaw);
  data.chatId = chatId;
  await env.BUNGA_ICE_ORDERS.put(`order:${orderCode}`, JSON.stringify(data));

  await forwardTelegramMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, chatId, message.message_id);
  await sendTelegramMessage(
    env,
    env.TELEGRAM_ADMIN_CHAT_ID,
    `☝️ Bukti bayar buat order ${orderCode}. Balas "ok ${orderCode}" kalau diterima, atau "masalah ${orderCode} <alasan>" kalau ada kendala.`
  );

  await sendTelegramMessage(env, chatId, "Bukti pembayaran kamu udah kami terima, ditunggu konfirmasi dari admin ya 🙏");
}

async function handleAdminReply(text, env) {
  const parts = text.trim().split(" ");
  const command = parts[0]?.toLowerCase();
  const orderCode = parts[1];

  if (!orderCode || !ORDER_CODE_REGEX.test(orderCode)) return;

  const dataRaw = await env.BUNGA_ICE_ORDERS.get(`order:${orderCode}`);
  if (!dataRaw) {
    await sendTelegramMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, `Order ${orderCode} nggak ketemu di database.`);
    return;
  }

  const data = JSON.parse(dataRaw);
  if (!data.chatId) {
    await sendTelegramMessage(
      env,
      env.TELEGRAM_ADMIN_CHAT_ID,
      `Customer buat order ${orderCode} belum kirim bukti bayar / belum ke-link.`
    );
    return;
  }

  if (command === "ok") {
  data.status = "diterima";
  const struk = formatStruk(data.order);
  await sendTelegramMessage(env, data.chatId, struk);
}

else if (command === "masalah") {
    const alasan = parts.slice(2).join(" ") || "Ada kendala pada bukti pembayaran";
    data.status = "masalah";
    await sendTelegramMessage(
      env,
      data.chatId,
      `⚠️ Ada kendala pada order ${orderCode}: ${alasan}\n\nMohon hubungi kami lagi di sini ya.`
    );
  }

 else {
    return;
  }

  await env.BUNGA_ICE_ORDERS.put(`order:${orderCode}`, JSON.stringify(data));
}

async function sendTelegramMessage(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${errBody}`);
  }
}

async function forwardTelegramMessage(env, toChatId, fromChatId, messageId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/forwardMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  });
}

async function handleAdminDashboard(request, env) {
  const auth = request.headers.get("Authorization");
  const valid = auth && checkAuth(auth, env.ADMIN_PASSWORD);

  if (!valid) {
    return new Response("Auth required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Bunga Ice Admin"' },
    });
  }

  const list = await env.BUNGA_ICE_ORDERS.list({ prefix: "order:" });
  const orders = [];
  for (const key of list.keys) {
    const raw = await env.BUNGA_ICE_ORDERS.get(key.name);
    if (raw) orders.push(JSON.parse(raw));
  }

  orders.sort((a, b) => new Date(b.order.createdAt) - new Date(a.order.createdAt));

  return new Response(renderDashboardHtml(orders), {
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

function checkAuth(authHeader, password) {
  const encoded = authHeader.replace("Basic ", "");
  const decoded = atob(encoded);
  const pass = decoded.split(":")[1];
  return pass === password;
}

function renderDashboardHtml(orders) {
  const rows = orders.map(({ order, status }) => {
    const items = order.items.map((i) => `${i.qty}x ${i.namaProduk}`).join(", ");
    const waktu = new Date(order.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    return `<tr>
      <td>${order.orderCode}</td>
      <td>${order.namaPemesan || "-"}</td>
      <td>${items}</td>
      <td>Rp${Number(order.total).toLocaleString("id-ID")}</td>
      <td>${status}</td>
      <td>${waktu}</td>
    </tr>`;
  }).join("");
  
  

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard Bunga Ice</title>
<style>
  body { font-family: system-ui, sans-serif; background:#111; color:#eee; padding:1rem; margin:0; }
  h1 { font-size:1.3rem; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width:100%; min-width:600px; border-collapse: collapse; font-size:0.8rem; }
  th, td { border:1px solid #333; padding:6px 8px; text-align:left; white-space: nowrap; }
  td:nth-child(3) { white-space: normal; min-width:150px; }
  th { background:#222; position: sticky; top:0; }
  tr:nth-child(even) { background:#1a1a1a; }
</style>
</head>
<body>
<h1>📊 Dashboard Order - Bunga Ice</h1>
<p>Total order: ${orders.length}</p>
<div class="table-wrap">
<table>
<thead>
<tr><th>Kode</th><th>Nama</th><th>Produk</th><th>Total</th><th>Status</th><th>Waktu</th></tr>
</thead>
<tbody>${rows}</tbody>
</table>
</div>
</body>
</html>`;
}
function formatStruk(order) {
  const itemsText = order.items
    .map((item) => {
      const varian = item.varianTerpilih.map((v) => v.nama_varian).join(", ");
      const namaLengkap = varian ? `${item.namaProduk} (${varian})` : item.namaProduk;
      const subtotal = item.hargaSatuan * item.qty;
      const namaPotong = namaLengkap.length > 20 ? namaLengkap.slice(0, 20) : namaLengkap;
      const hargaText = `Rp${subtotal.toLocaleString("id-ID")}`;
      const spasi = " ".repeat(Math.max(1, 24 - namaPotong.length - hargaText.length));
      return `${item.qty}x ${namaPotong}${spasi}${hargaText}`;
    })
    .join("\n");

  const ambilText = order.ambil === "hari_ini" ? "Hari ini" : "Besok";
  const waktu = new Date(order.createdAt).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
  return (
    "```\n" +
    "     BUNGA ICE AND SNACK\n" +
    "  \"where every flavor tells a story\"\n" +
    "────────────────────────\n" +
    `Kode : ${order.orderCode}\n` +
    `Tgl  : ${waktu}\n` +
    "────────────────────────\n" +
    `${itemsText}\n` +
    "────────────────────────\n" +
    `TOTAL${" ".repeat(19 - String(Number(order.total).toLocaleString("id-ID")).length)}Rp${Number(order.total).toLocaleString("id-ID")}\n` +
    "────────────────────────\n\n" +
    `Ambil: ${ambilText}, jam ${order.jamAmbil}\n\n` +
    "Tunjukin struk ini ke kakak\n" +
    "pas ambil pesanan ya 🙏\n" +
    "```"
  );
}
