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
    await sendTelegramMessage(
      env,
      data.chatId,
      `✅ Pembayaran buat order ${orderCode} udah dikonfirmasi! Pesanan kamu segera diproses. Terima kasih! 🙏`
    );
  } else if (command === "masalah") {
    const alasan = parts.slice(2).join(" ") || "Ada kendala pada bukti pembayaran";
    data.status = "masalah";
    await sendTelegramMessage(
      env,
      data.chatId,
      `⚠️ Ada kendala pada order ${orderCode}: ${alasan}\n\nMohon hubungi kami lagi di sini ya.`
    );
  } else {
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