const ORDER_CODE_REGEX = /BIS-\d{6}-[A-Z0-9]{4}/;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
  return new Response(null, { headers: corsHeaders });
}

const url = new URL(request.url);
if (request.method === "GET" && url.pathname === "/admin") {
  return handleAdminDashboard(request, env);
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
    const waktu = new Date(order.createdAt).toLocaleString("id-ID");
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
  const waktu = new Date(order.createdAt).toLocaleString("id-ID", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  });

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