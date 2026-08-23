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
    SELECT p.id, p.category_id, p.name, p.slug, p.description, p.base_price AS harga,
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
      kategori_id: p.category_id || null, kategori: p.kategori || "Menu",
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
  if (url.pathname === "/api/admin/categories" && request.method === "GET") {
    const data = await env.BUNGA_ICE_DB.prepare(`SELECT id, name, sort_order, is_active FROM categories WHERE is_active = 1 ORDER BY sort_order, name`).all();
    return jsonResponse({ categories: data.results || [] }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/categories" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name || name.length > 60) return jsonResponse({ success: false, error: "Nama kategori wajib diisi maksimal 60 karakter" }, 400, corsHeaders);
    const existing = await env.BUNGA_ICE_DB.prepare(`SELECT id FROM categories WHERE lower(name) = lower(?) AND is_active = 1`).bind(name).first();
    if (existing) return jsonResponse({ success: false, error: "Kategori tersebut sudah ada" }, 409, corsHeaders);
    const id = `CAT-${crypto.randomUUID().slice(0, 8)}`;
    const next = await env.BUNGA_ICE_DB.prepare(`SELECT COALESCE(MAX(sort_order) + 1, 1) AS sort_order FROM categories`).first();
    const sortOrder = Number(next?.sort_order || 1);
    await env.BUNGA_ICE_DB.prepare(`INSERT INTO categories (id, name, sort_order, is_active) VALUES (?, ?, ?, 1)`).bind(id, name, sortOrder).run();
    return jsonResponse({ success: true, category: { id, name, sort_order: sortOrder, is_active: 1 } }, 201, corsHeaders);
  }
  if (url.pathname === "/api/admin/products" && request.method === "GET") {
    const data = await env.BUNGA_ICE_DB.prepare(`SELECT p.id, p.category_id, p.name, p.description, p.base_price, p.is_active, p.is_available, p.sort_order, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.sort_order, p.name`).all();
    return jsonResponse({ products: data.results || [] }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/products" && request.method === "PUT") {
    const body = await request.json();
    if (!body.id || !body.name || !Number.isFinite(Number(body.base_price))) return jsonResponse({ success: false, error: "id, name, dan base_price wajib diisi" }, 400, corsHeaders);
    const categoryId = String(body.category_id || "").trim() || null;
    if (categoryId) {
      const category = await env.BUNGA_ICE_DB.prepare(`SELECT id FROM categories WHERE id = ? AND is_active = 1`).bind(categoryId).first();
      if (!category) return jsonResponse({ success: false, error: "Kategori tidak ditemukan" }, 400, corsHeaders);
    }
    await env.BUNGA_ICE_DB.prepare(`UPDATE products SET category_id = ?, name = ?, description = ?, base_price = ?, is_active = ?, is_available = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`).bind(categoryId, String(body.name).trim(), String(body.description || "").trim(), Math.max(0, Math.round(Number(body.base_price))), body.is_active === false ? 0 : 1, body.is_available === false ? 0 : 1, Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0, String(body.id)).run();
    return jsonResponse({ success: true }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/variants" && request.method === "GET") {
    const productId = url.searchParams.get("product_id");
    if (!productId) return jsonResponse({ success: false, error: "product_id wajib diisi" }, 400, corsHeaders);
    const groups = await env.BUNGA_ICE_DB.prepare(`SELECT id, name, input_type, is_required, sort_order, is_active FROM variant_groups WHERE product_id = ? ORDER BY sort_order, name`).bind(productId).all();
    const variants = await env.BUNGA_ICE_DB.prepare(`SELECT v.id, v.group_id, v.name, v.price_delta, v.sort_order, v.is_active FROM variants v JOIN variant_groups g ON g.id = v.group_id WHERE g.product_id = ? ORDER BY v.group_id, v.sort_order, v.name`).bind(productId).all();
    return jsonResponse({ groups: groups.results || [], variants: variants.results || [] }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/variants" && request.method === "PUT") {
    const body = await request.json();
    const productId = String(body.product_id || "");
    if (!productId || !Array.isArray(body.groups)) return jsonResponse({ success: false, error: "product_id dan groups wajib diisi" }, 400, corsHeaders);
    const statements = [
      env.BUNGA_ICE_DB.prepare(`UPDATE variant_groups SET is_active = 0 WHERE product_id = ?`).bind(productId),
      env.BUNGA_ICE_DB.prepare(`DELETE FROM variants WHERE group_id IN (SELECT id FROM variant_groups WHERE product_id = ?)`).bind(productId)
    ];
    for (const [gi, group] of body.groups.entries()) {
      const groupId = String(group.id || `VG-${productId}-${crypto.randomUUID().slice(0, 8)}`);
      statements.push(env.BUNGA_ICE_DB.prepare(`INSERT INTO variant_groups (id, product_id, name, input_type, is_required, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,input_type=excluded.input_type,is_required=excluded.is_required,sort_order=excluded.sort_order,is_active=1`).bind(groupId, productId, String(group.name || "Pilihan").trim(), String(group.input_type || "radio"), group.is_required ? 1 : 0, gi));
      for (const [vi, variant] of (Array.isArray(group.variants) ? group.variants : []).entries()) {
        const variantId = String(variant.id || `V-${crypto.randomUUID().slice(0, 8)}`);
        statements.push(env.BUNGA_ICE_DB.prepare(`INSERT INTO variants (id, group_id, name, price_delta, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,name=excluded.name,price_delta=excluded.price_delta,sort_order=excluded.sort_order,is_active=1`).bind(variantId, groupId, String(variant.name || "").trim(), Math.round(Number(variant.price_delta || 0)), vi));
      }
    }
    await env.BUNGA_ICE_DB.batch(statements);
    return jsonResponse({ success: true }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/orders" && request.method === "GET") {
    const status = url.searchParams.get("status");
    const date = url.searchParams.get("date");
    const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
    const conditions = [];
    const params = [];
    if (validDate) { conditions.push("date(created_at, '+7 hours') = ?"); params.push(validDate); }
    if (status) { conditions.push("status = ?"); params.push(status); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT * FROM orders${where} ORDER BY created_at DESC LIMIT 100`;
    const result = await env.BUNGA_ICE_DB.prepare(query).bind(...params).all();
    return jsonResponse({ orders: result.results || [], date: validDate || null }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/orders/summary" && request.method === "GET") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const validFrom = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : "";
    const validTo = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : "";
    if (!validFrom || !validTo) return jsonResponse({ success: false, error: "from dan to wajib berupa tanggal YYYY-MM-DD" }, 400, corsHeaders);
    const result = await env.BUNGA_ICE_DB.prepare(`SELECT date(created_at, '+7 hours') AS order_date, COUNT(*) AS order_count, COALESCE(SUM(total), 0) AS total, SUM(CASE WHEN status = 'selesai' THEN 1 ELSE 0 END) AS completed_count, SUM(CASE WHEN status = 'dibatalkan' THEN 1 ELSE 0 END) AS cancelled_count FROM orders WHERE date(created_at, '+7 hours') BETWEEN ? AND ? GROUP BY order_date ORDER BY order_date DESC`).bind(validFrom, validTo).all();
    const days = result.results || [];
    const totals = days.reduce((acc, day) => ({ order_count: acc.order_count + Number(day.order_count || 0), total: acc.total + Number(day.total || 0), completed_count: acc.completed_count + Number(day.completed_count || 0), cancelled_count: acc.cancelled_count + Number(day.cancelled_count || 0) }), { order_count: 0, total: 0, completed_count: 0, cancelled_count: 0 });
    return jsonResponse({ from: validFrom, to: validTo, totals, days }, 200, corsHeaders);
  }
  const orderDetailMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (orderDetailMatch && request.method === "GET") {
    const order = await env.BUNGA_ICE_DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderDetailMatch[1]).first();
    if (!order) return jsonResponse({ success: false, error: "Order tidak ditemukan" }, 404, corsHeaders);
    const items = await env.BUNGA_ICE_DB.prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid`).bind(orderDetailMatch[1]).all();
    return jsonResponse({ order, items: items.results || [] }, 200, corsHeaders);
  }
  const orderStatusMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
  if (orderStatusMatch && request.method === "PUT") {
    const body = await request.json();
    const allowed = ["menunggu_bukti", "diterima", "masalah", "selesai", "dibatalkan"];
    if (!allowed.includes(body.status)) return jsonResponse({ success: false, error: "Status tidak valid" }, 400, corsHeaders);
    await env.BUNGA_ICE_DB.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(body.status, orderStatusMatch[1]).run();
    return jsonResponse({ success: true }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/settings" && request.method === "GET") {
    const result = await env.BUNGA_ICE_DB.prepare(`SELECT key, value FROM store_settings ORDER BY key`).all();
    return jsonResponse({ settings: result.results || [] }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/settings" && request.method === "PUT") {
    const body = await request.json();
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Format setting tidak valid" }, 400, corsHeaders);
    const entries = Object.entries(body).filter(([key, value]) => /^[a-z0-9_]{1,50}$/.test(key) && typeof value === "string");
    await env.BUNGA_ICE_DB.batch(entries.map(([key, value]) => env.BUNGA_ICE_DB.prepare(`INSERT INTO store_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).bind(key, value.slice(0, 500))));
    return jsonResponse({ success: true }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/images" && request.method === "GET") {
    const productId = url.searchParams.get("product_id");
    if (!productId) return jsonResponse({ success: false, error: "product_id wajib diisi" }, 400, corsHeaders);
    const result = await env.BUNGA_ICE_DB.prepare(`SELECT id, product_id, object_key, alt_text, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order, created_at`).bind(productId).all();
    return jsonResponse({ images: result.results || [] }, 200, corsHeaders);
  }
  const imageMatch = url.pathname.match(/^\/api\/admin\/images\/([^/]+)$/);
  if (imageMatch && request.method === "DELETE") {
    const image = await env.BUNGA_ICE_DB.prepare(`SELECT object_key FROM product_images WHERE id = ?`).bind(imageMatch[1]).first();
    if (!image) return jsonResponse({ success: false, error: "Foto tidak ditemukan" }, 404, corsHeaders);
    if (env.BUNGA_ICE_ASSETS) await env.BUNGA_ICE_ASSETS.delete(image.object_key);
    await env.BUNGA_ICE_DB.prepare(`DELETE FROM product_images WHERE id = ?`).bind(imageMatch[1]).run();
    return jsonResponse({ success: true }, 200, corsHeaders);
  }
  if (url.pathname === "/api/admin/upload" && request.method === "POST") {
    if (!env.BUNGA_ICE_ASSETS) return jsonResponse({ success: false, error: "R2 belum terpasang" }, 503, corsHeaders);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonResponse({ success: false, error: "file wajib diisi" }, 400, corsHeaders);
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) return jsonResponse({ success: false, error: "File harus gambar maksimal 5MB" }, 400, corsHeaders);
    const safeName = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const productId = String(form.get("product_id") || "");
    const key = `products/${crypto.randomUUID()}-${safeName}`;
    await env.BUNGA_ICE_ASSETS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    if (productId) {
      const product = await env.BUNGA_ICE_DB.prepare(`SELECT id FROM products WHERE id = ?`).bind(productId).first();
      if (!product) return jsonResponse({ success: false, error: "Produk tidak ditemukan" }, 404, corsHeaders);
      const imageId = crypto.randomUUID();
      await env.BUNGA_ICE_DB.prepare(`INSERT INTO product_images (id, product_id, object_key, alt_text, sort_order) VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM product_images WHERE product_id = ?), 0))`).bind(imageId, productId, key, file.name.slice(0, 120), productId).run();
    }
    return jsonResponse({ success: true, object_key: key, url: `/media/${encodeURIComponent(key)}`, product_id: productId || null }, 201, corsHeaders);
  }
  return jsonResponse({ success: false, error: "Admin route tidak ditemukan" }, 404, corsHeaders);
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

async function handleNewOrder(order, env, corsHeaders) {
  try {
    if (!env.BUNGA_ICE_DB) throw new Error("D1 belum terpasang");
    if (!order.orderCode || !/^BIS-\d{6}-[A-Z0-9]{4}$/.test(order.orderCode)) throw new Error("Kode order tidak valid");
    if (!Array.isArray(order.items) || order.items.length === 0) throw new Error("Pesanan kosong");
    if (!["hari_ini", "besok"].includes(order.ambil) || !order.jamAmbil) throw new Error("Waktu pengambilan tidak valid");

    const normalized = [];
    let serverTotal = 0;
    for (const item of order.items) {
      const productId = String(item.produkId || item.productId || "");
      const quantity = Math.floor(Number(item.qty));
      if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("Item order tidak valid");
      const productResult = await env.BUNGA_ICE_DB.prepare(`SELECT id, name, base_price FROM products WHERE id = ? AND is_active = 1 AND is_available = 1`).bind(productId).all();
      const product = productResult.results?.[0];
      if (!product) throw new Error(`Produk ${productId} tidak tersedia`);

      const selected = Array.isArray(item.varianTerpilih) ? item.varianTerpilih : [];
      const variantIds = selected.map((v) => String(v.id_varian || "")).filter(Boolean);
      let variants = [];
      if (variantIds.length) {
        const placeholders = variantIds.map(() => "?").join(",");
        const variantResult = await env.BUNGA_ICE_DB.prepare(`SELECT v.id, v.name, v.price_delta, vg.product_id FROM variants v JOIN variant_groups vg ON vg.id = v.group_id WHERE v.id IN (${placeholders}) AND v.is_active = 1 AND vg.is_active = 1 AND vg.product_id = ?`).bind(...variantIds, productId).all();
        variants = variantResult.results || [];
        if (variants.length !== variantIds.length) throw new Error(`Varian ${productId} tidak valid`);
      }
      const variantSnapshot = variants.map((v) => ({ id_varian: v.id, nama_varian: v.name, tambah_harga: Number(v.price_delta || 0) }));
      const unitPrice = Number(product.base_price) + variantSnapshot.reduce((sum, v) => sum + v.tambah_harga, 0);
      const subtotal = unitPrice * quantity;
      serverTotal += subtotal;
      normalized.push({ productId, productName: product.name, unitPrice, quantity, variants: variantSnapshot, subtotal });
    }
    if (Number(order.total) !== serverTotal) throw new Error("Total pesanan tidak sesuai harga menu");

    const orderId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const orderInsert = env.BUNGA_ICE_DB.prepare(`INSERT INTO orders (id, order_code, customer_name, customer_phone, pickup_day, pickup_time, note, status, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'menunggu_bukti', ?, ?)`).bind(orderId, order.orderCode, String(order.namaPemesan || "").slice(0, 120), String(order.noHp || "").slice(0, 40), order.ambil, order.jamAmbil, String(order.catatan || "").slice(0, 500), serverTotal, createdAt);
    const itemStatements = normalized.map((item) => env.BUNGA_ICE_DB.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, unit_price_snapshot, quantity, variants_json, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), orderId, item.productId, item.productName, item.unitPrice, item.quantity, JSON.stringify(item.variants), item.subtotal));
    await env.BUNGA_ICE_DB.batch([orderInsert, ...itemStatements]);

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_CHAT_ID) {
      const itemsText = normalized.map((item) => `• ${item.quantity}x ${item.productName} - Rp${item.subtotal.toLocaleString("id-ID")}`).join("\n");
      const message = `🛍️ Order Baru!\n\nKode: ${order.orderCode}\n\n${itemsText}\n\nTotal: Rp${serverTotal.toLocaleString("id-ID")}\nAmbil: ${order.ambil === "hari_ini" ? "Hari ini" : "Besok"}, jam ${order.jamAmbil}${order.namaPemesan ? `\nNama: ${order.namaPemesan}` : ""}${order.noHp ? `\nHP: ${order.noHp}` : ""}${order.catatan ? `\nCatatan: ${order.catatan}` : ""}\n\nMenunggu bukti pembayaran dari customer.`;
      await sendTelegramMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, message);
    }

    return jsonResponse({ success: true, orderCode: order.orderCode, total: serverTotal, notification: Boolean(env.TELEGRAM_BOT_TOKEN) }, 200, corsHeaders);
  } catch (err) {
    console.log("ERROR DI HANDLENEWORDER:", err.message);
    return jsonResponse({ success: false, error: err.message }, 400, corsHeaders);
  }
}

async function getD1OrderContext(orderCode, env) {
  if (!env.BUNGA_ICE_DB) return null;
  const order = await env.BUNGA_ICE_DB.prepare(`SELECT * FROM orders WHERE order_code = ?`).bind(orderCode).first();
  if (!order) return null;
  const itemResult = await env.BUNGA_ICE_DB.prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid`).bind(order.id).all();
  const items = (itemResult.results || []).map((item) => ({
    qty: item.quantity,
    namaProduk: item.product_name_snapshot,
    hargaSatuan: item.unit_price_snapshot,
    varianTerpilih: (() => { try { return JSON.parse(item.variants_json || "[]"); } catch { return []; } })()
  }));
  return { order: { orderCode: order.order_code, namaPemesan: order.customer_name, noHp: order.customer_phone, ambil: order.pickup_day, jamAmbil: order.pickup_time, catatan: order.note, total: order.total, createdAt: order.created_at, items }, status: order.status, chatId: order.telegram_chat_id };
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
  let data = await getD1OrderContext(orderCode, env);
  if (data) {
    await env.BUNGA_ICE_DB.prepare(`UPDATE orders SET telegram_chat_id = ?, updated_at = datetime('now') WHERE order_code = ?`).bind(String(chatId), orderCode).run();
    data.chatId = chatId;
  } else {
    const dataRaw = await env.BUNGA_ICE_ORDERS.get(`order:${orderCode}`);
    if (!dataRaw) {
      await sendTelegramMessage(env, chatId, `Kode pesanan ${orderCode} nggak ketemu. Coba cek lagi ya.`);
      return;
    }
    data = JSON.parse(dataRaw);
    data.chatId = chatId;
    await env.BUNGA_ICE_ORDERS.put(`order:${orderCode}`, JSON.stringify(data));
  }

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

  let data = await getD1OrderContext(orderCode, env);
  let isD1 = Boolean(data);
  if (!data) {
    const dataRaw = await env.BUNGA_ICE_ORDERS.get(`order:${orderCode}`);
    if (!dataRaw) {
      await sendTelegramMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, `Order ${orderCode} nggak ketemu di database.`);
      return;
    }
    data = JSON.parse(dataRaw);
  }
  if (!data.chatId) {
    await sendTelegramMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, `Customer buat order ${orderCode} belum kirim bukti bayar / belum ke-link.`);
    return;
  }
  if (command === "ok") {
    data.status = "diterima";
    await sendTelegramMessage(env, data.chatId, formatStruk(data.order));
  } else if (command === "masalah") {
    const alasan = parts.slice(2).join(" ") || "Ada kendala pada bukti pembayaran";
    data.status = "masalah";
    await sendTelegramMessage(env, data.chatId, `⚠️ Ada kendala pada order ${orderCode}: ${alasan}\n\nMohon hubungi kami lagi di sini ya.`);
  } else {
    return;
  }
  if (isD1) {
    await env.BUNGA_ICE_DB.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE order_code = ?`).bind(data.status, orderCode).run();
  } else {
    await env.BUNGA_ICE_ORDERS.put(`order:${orderCode}`, JSON.stringify(data));
  }
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
