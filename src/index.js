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

    try {
      const order = await request.json();

      const itemsText = order.items
        .map((item) => {
          const varian = item.varianTerpilih.map((v) => v.nama_varian).join(", ");
          const subtotal = item.hargaSatuan * item.qty;
          return `• ${item.qty}x ${item.namaProduk} (${varian}) - Rp${subtotal.toLocaleString("id-ID")}`;
        })
        .join("\n");

      const ambilText = order.ambil === "hari_ini" ? "Hari ini" : "Besok";

      const message =
        `🛍️ Order Baru!\n\n` +
        `Kode: ${order.orderCode}\n\n` +
        `${itemsText}\n\n` +
        `Total: Rp${Number(order.total).toLocaleString("id-ID")}\n` +
        `Ambil: ${ambilText}, jam ${order.jamAmbil}\n\n` +
        `Menunggu bukti pembayaran dari customer.`;

      const tgRes = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
            text: message,
          }),
        }
      );

      if (!tgRes.ok) {
        return new Response(
          JSON.stringify({ success: false, error: "Gagal kirim notif Telegram" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

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
  },
};
