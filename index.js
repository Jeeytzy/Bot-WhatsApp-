const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    proto,
    getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const config = require('./config');
const db = require('./lib/database');
const payment = require('./lib/payment');
const helper = require('./lib/helper');

global.db = db;
global.payment = payment;
global.helper = helper;
global.config = config;
global.paymentTimers = new Map();
global.processedDeposits = new Map();
global.userStates = new Map();
global.processingLocks = new Map();

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
        browser: ['Ebook Store Bot', 'Chrome', '121.0.0'],
        markOnlineOnConnect: true,
        getMessage: async (key) => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
            return proto.Message.fromObject({});
        }
    });

    store.bind(sock.ev);

    if (!sock.authState.creds.registered) {
        console.log('📱 Masukkan nomor WhatsApp:');
        const phoneNumber = await new Promise(resolve => {
            process.stdin.once('data', data => resolve(data.toString().trim()));
        });
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`🔑 Kode Pairing: ${code}`);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            cleanupOnDisconnect();
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ Bot Connected!');
            global.processedDeposits = await db.getProcessedDeposits();
            startStateCleanupInterval();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
            await handleCommand(sock, msg);
        } catch (error) {
            console.error('Message Handler Error:', error);
            await db.logError(error, 'Message Handler');
        }
    });

    return sock;
}

function cleanupOnDisconnect() {
    for (const [key, timer] of global.paymentTimers) {
        clearTimeout(timer);
    }
    global.paymentTimers.clear();
    global.userStates.clear();
    global.processingLocks.clear();
    console.log('🧹 Cleaned up all timers and states');
}

function startStateCleanupInterval() {
    setInterval(() => {
        const now = Date.now();
        for (const [userId, state] of global.userStates.entries()) {
            if (state.timestamp && (now - state.timestamp > 300000)) {
                global.userStates.delete(userId);
                console.log(`🗑️ Cleaned expired state for ${userId}`);
            }
        }
    }, 60000);
}

async function handleCommand(sock, msg) {
    const messageType = getContentType(msg.message);
    const body = (
        messageType === 'conversation' ? msg.message.conversation :
        messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text :
        messageType === 'imageMessage' ? msg.message.imageMessage.caption :
        messageType === 'videoMessage' ? msg.message.videoMessage.caption : ''
    ).trim();

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : from;
    const senderNumber = helper.extractNumber(sender);
    const isOwner = senderNumber === config.OWNER_NUMBER;
    const pushname = msg.pushName || 'User';
    const args = body.split(/\s+/);
    const command = args[0].toLowerCase();

    await db.createUser({ id: senderNumber, name: pushname });

    const m = {
        sock, msg, from, sender, senderNumber, isGroup, isOwner, pushname, body, command,
        args: args.slice(1),
        quoted: msg.message.extendedTextMessage?.contextInfo?.quotedMessage || null,
        reply: async (text) => {
            try {
                return await sock.sendMessage(from, { text }, { quoted: msg });
            } catch (error) {
                console.error('Reply Error:', error);
                return null;
            }
        },
        replyWithImage: async (image, caption) => {
            try {
                return await sock.sendMessage(from, { image, caption }, { quoted: msg });
            } catch (error) {
                console.error('ReplyWithImage Error:', error);
                return null;
            }
        }
    };

    console.log(`📩 ${pushname} (${senderNumber}): ${body}`);

    const userState = global.userStates.get(senderNumber);
    if (userState) {
        return await handleWizardState(m, userState);
    }

    const cmd = command.replace(config.PREFIX, '');

    try {
        switch (cmd) {
            case 'menu':
            case 'start': {
                const user = await db.getUser(senderNumber);
                const products = await db.getProducts();
                const users = await db.getUsers();
                const totalTransactions = products.reduce((sum, p) => sum + p.terjual, 0);

                let text = `╭━━━『 *${config.BOT_NAME}* 』━━━╮
│
│ 👋 Hai, ${pushname}!
│ Selamat datang di Toko Ebook
│
├━━━『 INFO AKUN 』━━━
│ 📱 Nomor: ${senderNumber}
│ 💰 Saldo: ${helper.formatRupiah(user.saldo)}
│ 📊 Transaksi: ${user.totalTransactions || 0}x
│
├━━━『 STATISTIK BOT 』━━━
│ 👥 Total User: ${users.length}
│ 📚 Total Produk: ${products.length}
│ 💳 Total Transaksi: ${totalTransactions}
│
├━━━『 MENU USER 』━━━
│ 📚 ${config.PREFIX}katalog - Lihat produk
│ 💰 ${config.PREFIX}saldo - Cek saldo
│ 💵 ${config.PREFIX}topup - Top up saldo
│ 🛒 ${config.PREFIX}beli - Beli produk
│ 📜 ${config.PREFIX}riwayat - Riwayat order
│ ❓ ${config.PREFIX}bantuan - Bantuan
│ 📋 ${config.PREFIX}sk - Syarat & Ketentuan
│`;

                if (isOwner) {
                    text += `
├━━━『 OWNER MENU 』━━━
│ ➕ ${config.PREFIX}addproduk - Tambah produk
│ ✏️ ${config.PREFIX}editproduk - Edit produk
│ 🗑️ ${config.PREFIX}delproduk - Hapus produk
│ 👥 ${config.PREFIX}listuser - List user
│ 📢 ${config.PREFIX}broadcast - Broadcast
│ 📊 ${config.PREFIX}stats - Statistik
│ 💎 ${config.PREFIX}addsaldo - Tambah saldo user`;
                }

                text += `
│
├━━━『 INFO 』━━━
│ ⏰ Waktu: ${helper.getWIBDateTime()}
│ 👨‍💻 Developer: ${config.OWNER_NAME}
│
╰━━━━━━━━━━━━━━━━━━╯

✨ *Fitur Otomatis:*
✅ Pembayaran QRIS otomatis
✅ Link download auto-send
✅ Notifikasi real-time
✅ Refund otomatis jika gagal

⚠️ *PENTING:*
- Saldo tidak bisa di-refund
- Link download hanya dikirim 1x
- Simpan link dengan baik`;

                await m.reply(text);
            }
            break;

            case 'katalog':
            case 'produk': {
                const products = await db.getProducts();
                if (products.length === 0) {
                    return await m.reply('📭 Maaf, katalog masih kosong!');
                }

                let catalogText = `╭━━━『 📚 KATALOG EBOOK 』━━━╮
│
│ Total: ${products.length} produk
│
`;
                products.forEach((product, index) => {
                    catalogText += `├━━━『 ${index + 1}. ${product.nama} 』━━━
│ 💰 Harga: ${helper.formatRupiah(product.harga)}
│ 📦 Stok: ${product.stok_tersisa} tersedia
│ 🔥 Terjual: ${product.terjual}x
│ 📝 ${product.deskripsi}
│ 🆔 ID: ${product.id}
│
`;
                });

                catalogText += `╰━━━━━━━━━━━━━━━━━━╯

📌 Cara Beli:
Ketik: *${config.PREFIX}beli [ID_PRODUK]*
Contoh: *${config.PREFIX}beli ${products[0].id}*`;

                await m.reply(catalogText);
            }
            break;

            case 'saldo':
            case 'balance': {
                const user = await db.getUser(senderNumber);
                const saldoText = `╭━━━『 💰 CEK SALDO 』━━━╮
│
│ 👤 Nama: ${user.name}
│ 📱 Nomor: ${senderNumber}
│ 💵 Saldo: ${helper.formatRupiah(user.saldo)}
│ 📊 Total Transaksi: ${user.totalTransactions || 0}x
│ 📅 Bergabung: ${new Date(user.joinDate).toLocaleDateString('id-ID')}
│ ⏰ Waktu: ${helper.getWIBDateTime()}
│
╰━━━━━━━━━━━━━━━━━━╯

💡 *Tips:*
- Gunakan saldo untuk beli ebook
- Top up: *${config.PREFIX}topup*
- Saldo tidak bisa di-refund`;

                await m.reply(saldoText);
            }
            break;

            case 'topup': {
                if (m.args.length === 0) {
                    return await m.reply(`💵 *TOP UP SALDO*

Cara top up:
*${config.PREFIX}topup [nominal]*

Contoh:
*${config.PREFIX}topup 10000*
*${config.PREFIX}topup 50000*

💡 Minimal top up: Rp 5.000
💳 Metode: QRIS (Auto-verify)`);
                }

                const nominal = parseInt(m.args[0]);
                if (isNaN(nominal) || nominal < 5000) {
                    return await m.reply('❌ Nominal minimal Rp 5.000!');
                }

                try {
                    await m.reply('🔄 Membuat pembayaran...');
                    const deposit = await payment.createDeposit(nominal);
                    const qrBuffer = Buffer.from(deposit.qr_image.split(',')[1], 'base64');
                    
                    const caption = `╭━━━『 💳 TOP UP SALDO 』━━━╮
│
│ 💰 Nominal: ${helper.formatRupiah(nominal)}
│ 💵 Dapat Saldo: ${helper.formatRupiah(deposit.get_balance)}
│ ⏰ Batas Waktu: 5 menit
│ 🆔 ID: ${deposit.id}
│
╰━━━━━━━━━━━━━━━━━━╯

📱 *Cara Bayar:*
1. Scan QR code di atas
2. Bayar sesuai nominal
3. Saldo otomatis masuk!

⏳ Mengecek pembayaran otomatis...`;

                    await m.replyWithImage(qrBuffer, caption);
                    startTopupCheck(m, deposit.id, 0);
                } catch (error) {
                    console.error('Error creating topup:', error);
                    await m.reply('❌ Maaf, sistem payment sedang error. Coba lagi nanti!');
                }
            }
            break;

            case 'beli':
            case 'buy': {
                if (m.args.length === 0) {
                    return await m.reply(`🛒 *CARA BELI EBOOK*

Format:
*${config.PREFIX}beli [ID_PRODUK]*

Contoh:
*${config.PREFIX}beli ebook1234567890*

📚 Lihat katalog: *${config.PREFIX}katalog*`);
                }

                const productId = m.args[0];
                const product = await db.getProduct(productId);

                if (!product) {
                    return await m.reply('❌ Produk tidak ditemukan!');
                }

                if (product.stok_tersisa === 0) {
                    return await m.reply('😢 Maaf, stok habis!');
                }

                const user = await db.getUser(senderNumber);
                const confirmText = `╭━━━『 🛒 KONFIRMASI PEMBELIAN 』━━━╮
│
│ 📚 Produk: ${product.nama}
│ 💰 Harga: ${helper.formatRupiah(product.harga)}
│ 📦 Stok: ${product.stok_tersisa}
│
│ 💵 Saldo Kamu: ${helper.formatRupiah(user.saldo)}
│
╰━━━━━━━━━━━━━━━━━━╯

💡 *Pilih Metode Pembayaran:*

1️⃣ Bayar dengan Saldo ${user.saldo >= product.harga ? '✅' : '❌'}
   Reply: *1*

2️⃣ Bayar dengan QRIS (Langsung) ✅
   Reply: *2*

Ketik *batal* untuk membatalkan`;

                await m.reply(confirmText);

                global.userStates.set(senderNumber, {
                    state: 'waiting_payment_method',
                    productId: productId,
                    productPrice: product.harga,
                    timestamp: Date.now()
                });
            }
            break;

            case 'riwayat':
            case 'history': {
                const orders = await db.getUserOrders(senderNumber);
                const successOrders = orders.filter(o => o.status === 'success');

                if (successOrders.length === 0) {
                    return await m.reply(`📦 *RIWAYAT ORDER*

Belum ada riwayat pembelian.

🛒 Mulai belanja: *${config.PREFIX}katalog*`);
                }

                let historyText = `╭━━━『 📦 RIWAYAT ORDER 』━━━╮
│
│ Total Transaksi: ${successOrders.length}
│
`;
                const recentOrders = successOrders.slice(-10).reverse();
                recentOrders.forEach((order, index) => {
                    const date = new Date(order.createdAt).toLocaleDateString('id-ID');
                    historyText += `├━━━『 ${index + 1} 』━━━
│ 📚 ${order.productName}
│ 💰 ${helper.formatRupiah(order.price)}
│ 📅 ${date}
│ ✅ ${order.status}
│
`;
                });

                historyText += `╰━━━━━━━━━━━━━━━━━━╯

📌 Menampilkan 10 transaksi terakhir`;

                await m.reply(historyText);
            }
            break;

            case 'bantuan':
            case 'help': {
                const helpText = `╭━━━『 ❓ BANTUAN 』━━━╮
│
├━━━『 CARA BELI EBOOK 』━━━
│ 1. Ketik *${config.PREFIX}katalog*
│ 2. Pilih produk & catat ID-nya
│ 3. Ketik *${config.PREFIX}beli [ID]*
│ 4. Pilih metode bayar
│ 5. Selesaikan pembayaran
│ 6. Link otomatis dikirim!
│
├━━━『 CARA TOP UP 』━━━
│ 1. Ketik *${config.PREFIX}topup [nominal]*
│ 2. Scan QR code
│ 3. Bayar sesuai nominal
│ 4. Saldo otomatis masuk!
│
├━━━『 FITUR LAINNYA 』━━━
│ 💰 Cek Saldo: *${config.PREFIX}saldo*
│ 📜 Riwayat: *${config.PREFIX}riwayat*
│ 📋 S&K: *${config.PREFIX}sk*
│
├━━━『 PENTING 』━━━
│ ⚠️ Link download hanya 1x
│ ⚠️ Simpan link dengan baik
│ ⚠️ Tidak ada refund
│
╰━━━━━━━━━━━━━━━━━━╯

❓ Butuh bantuan?
Hubungi: wa.me/${config.OWNER_NUMBER}`;

                await m.reply(helpText);
            }
            break;

            case 'sk':
            case 'tos': {
                const skText = `╭━━━『 📋 SYARAT & KETENTUAN 』━━━╮
│
├━━━『 PEMBELIAN 』━━━
│ ✅ Bayar via QRIS/Saldo
│ ✅ Link kirim setelah bayar sukses
│ ✅ Batas waktu bayar: 5 menit
│
├━━━『 PRODUK DIGITAL 』━━━
│ 📚 Semua ebook untuk edukasi
│ 🔗 Link download hanya 1x
│ 💾 Simpan link dengan baik
│
├━━━『 REFUND 』━━━
│ ❌ Tidak ada refund setelah link terkirim
│ ⚠️ Komplain jika link rusak/error
│ ⏰ Hubungi owner max 24 jam
│
├━━━『 LARANGAN 』━━━
│ ❌ Dilarang share/jual ulang link
│ ❌ Dilarang spam/flood bot
│ ⚠️ Pelanggaran = banned
│
╰━━━━━━━━━━━━━━━━━━╯

✅ Dengan menggunakan bot ini,
   Anda menyetujui S&K di atas.

📞 Kontak: wa.me/${config.OWNER_NUMBER}`;

                await m.reply(skText);
            }
            break;

            case 'addproduk': {
                if (!isOwner) return m.reply('❌ Perintah khusus owner!');

                await m.reply(`➕ *TAMBAH PRODUK*

Ikuti format berikut:
━━━━━━━━━━━━━━━
Nama Produk
Harga (angka)
Deskripsi
Link1
Link2
Link3
━━━━━━━━━━━━━━━

Contoh:
━━━━━━━━━━━━━━━
Ebook Resep Masakan
15000
Kumpulan 100+ resep masakan nusantara
https://drive.google.com/file/d/xxx1
https://drive.google.com/file/d/xxx2
━━━━━━━━━━━━━━━

⚠️ Kirim gambar produk dengan caption format di atas!`);

                global.userStates.set(senderNumber, {
                    state: 'waiting_product_data',
                    timestamp: Date.now()
                });
            }
            break;

            case 'delproduk': {
                if (!isOwner) return m.reply('❌ Perintah khusus owner!');

                const products = await db.getProducts();
                if (products.length === 0) {
                    return await m.reply('📭 Tidak ada produk untuk dihapus!');
                }

                let listText = `╭━━━『 🗑️ HAPUS PRODUK 』━━━╮
│
│ Pilih produk yang akan dihapus:
│
`;
                products.forEach((product, index) => {
                    listText += `│ ${index + 1}. ${product.nama}
│    💰 ${helper.formatRupiah(product.harga)}
│    📦 Stok: ${product.stok_tersisa}
│    🆔 ${product.id}
│
`;
                });

                listText += `╰━━━━━━━━━━━━━━━━━━╯

Reply dengan ID produk untuk hapus
Contoh: ${products[0].id}`;

                await m.reply(listText);

                global.userStates.set(senderNumber, {
                    state: 'waiting_delete_product',
                    timestamp: Date.now()
                });
            }
            break;

            case 'editproduk': {
                if (!isOwner) return m.reply('❌ Perintah khusus owner!');

                const products = await db.getProducts();
                if (products.length === 0) {
                    return await m.reply('📭 Tidak ada produk untuk diedit!');
                }

                let listText = `╭━━━『 ✏️ EDIT PRODUK 』━━━╮
│
│ Pilih produk yang akan diedit:
│
`;
                products.forEach((product, index) => {
                    listText += `│ ${index + 1}. ${product.nama}
│    💰 ${helper.formatRupiah(product.harga)}
│    🆔 ${product.id}
│
`;
                });

                listText += `╰━━━━━━━━━━━━━━━━━━╯

Reply dengan ID produk untuk edit
Contoh: ${products[0].id}`;

                await m.reply(listText);

                global.userStates.set(senderNumber, {
                    state: 'waiting_edit_product_select',
                    timestamp: Date.now()
                });
            }
            break;

            case 'listuser': {
                if (!isOwner) return m.reply('❌ Perintah khusus owner!');

                const users = await db.getUsers();
                let userListText = `╭━━━『 👥 LIST USER 』━━━╮
│
│ Total User: ${users.length}
│
`;
                const topUsers = users.slice(0, 20);
                topUsers.forEach((user, index) => {
                    userListText += `├━━━『 ${index + 1} 』━━━
│ 👤 ${user.name}
│ 📱 ${helper.sensorId(user.id)}
│ 💰 ${helper.formatRupiah(user.saldo)}
│ 📊 ${user.totalTransactions || 0} transaksi
│
`;
                });

                userListText += `╰━━━━━━━━━━━━━━━━━━╯

📌 Menampilkan 20 user teratas`;

                await m.reply(userListText);
            }
            break;

            case 'broadcast':
            case 'bc': {
                if (!isOwner) return m.reply('❌ Perintah khusus owner!');

                if (m.args.length === 0) {
                    return await m.reply(`📢 *BROADCAST*

Format:
*${config.PREFIX}broadcast [pesan]*

Contoh:
*${config.PREFIX}broadcast Promo spesial hari ini!*

⚠️ Pesan akan dikirim ke semua user`);
                }

                const message = m.args.join(' ');
                const users = await db.getUsers();

                await m.reply(`🔄 Mengirim broadcast ke ${users.length} user...`);

                let success = 0;
                let failed = 0;

                for (const user of users) {
                    try {
                        const jid = helper.getJid(user.id);
                        await sock.sendMessage(jid, { 
                            text: `📢 *BROADCAST*\n\n${message}\n\n━━━━━━━━━━━\n${config.BOT_NAME}` 
                        });
                        success++;
                        await helper.sleep(1000);
                    } catch (error) {
                        failed++;
                        console.error(`Failed to send to ${user.id}:`, error.message);
                    }
                }

                await m.reply(`✅ Broadcast selesai!

📊 Hasil:
✅ Berhasil: ${success}
❌ Gagal: ${failed}`);
            }
            break;

            case 'stats': {
                if (!isOwner) return m.reply('❌ Perintah khusus owner!');

                const products = await db.getProducts();
                const users = await db.getUsers();
                const orders = await db.getOrders();

                const totalRevenue = orders
                    .filter(o => o.status === 'success')
                    .reduce((sum, o) => sum + o.price, 0);

                const totalTransactions = orders.filter(o => o.status === 'success').length;
                const totalStok = products.reduce((sum, p) => sum + p.stok_tersisa, 0);
                const activeUsers = users.filter(u => u.totalTransactions > 0).length;

                const topProduct = products.sort((a, b) => b.terjual - a.terjual)[0];

                const statsText = `╭━━━『 📊 STATISTIK LENGKAP 』━━━╮
│
├━━━『 USER 』━━━
│ 👥 Total User: ${users.length}
│ ✅ User Aktif: ${activeUsers}
│ 💤 User Pasif: ${users.length - activeUsers}
│
├━━━『 PRODUK 』━━━
│ 📚 Total Produk: ${products.length}
│ 📦 Total Stok: ${totalStok}
│ 🔥 Terlaris: ${topProduct ? topProduct.nama : '-'}
│
├━━━『 TRANSAKSI 』━━━
│ 💳 Total Transaksi: ${totalTransactions}
│ 💰 Total Revenue: ${helper.formatRupiah(totalRevenue)}
│ 📈 Rata-rata: ${helper.formatRupiah(totalTransactions > 0 ? Math.floor(totalRevenue / totalTransactions) : 0)}
│
├━━━『 SISTEM 』━━━
│ ⏰ Waktu: ${helper.getWIBDateTime()}
│ 🤖 Status: Online ✅
│ 📦 Deposits: ${global.processedDeposits.size}
│
╰━━━━━━━━━━━━━━━━━━╯`;

                await m.reply(statsText);
            }
            break;

            case 'addsaldo': {
                if (!isOwner) return m.reply('❌ Perintah khusus owner!');

                if (m.args.length < 2) {
                    return await m.reply(`💎 *TAMBAH SALDO USER*

Format:
*${config.PREFIX}addsaldo [nomor] [jumlah]*

Contoh:
*${config.PREFIX}addsaldo 6281234567890 50000*

⚠️ Nomor tanpa simbol +`);
                }

                const targetNumber = m.args[0].replace(/[^0-9]/g, '');
                const amount = parseInt(m.args[1]);

                if (isNaN(amount) || amount <= 0) {
                    return await m.reply('❌ Jumlah saldo harus angka positif!');
                }

                const user = await db.getUser(targetNumber);
                if (!user) {
                    return await m.reply('❌ User tidak ditemukan!');
                }

                const updated = await db.updateUserSaldo(targetNumber, amount);
                if (updated) {
                    await m.reply(`✅ Berhasil menambah saldo!

👤 User: ${user.name}
📱 Nomor: ${targetNumber}
💰 Saldo Baru: ${helper.formatRupiah(updated.saldo)}`);

                    try {
                        const jid = helper.getJid(targetNumber);
                        await sock.sendMessage(jid, {
                            text: `🎉 *SALDO DITAMBAHKAN*

💰 Saldo kamu ditambah ${helper.formatRupiah(amount)} oleh owner!

💵 Saldo Sekarang: ${helper.formatRupiah(updated.saldo)}

Terima kasih! 🙏`
                        });
                    } catch (error) {
                        console.error('Error notifying user:', error);
                    }
                } else {
                    await m.reply('❌ Gagal menambah saldo!');
                }
            }
            break;

            default:
                if (body.startsWith(config.PREFIX)) {
                    await m.reply(`❌ Perintah tidak dikenali!\nKetik *${config.PREFIX}menu* untuk melihat daftar perintah.`);
                }
                break;
        }
    } catch (error) {
        console.error('Error in command handler:', error);
        await db.logError(error, `Command: ${cmd}`);
        await m.reply('❌ Terjadi error saat memproses perintah!');
    }
}

async function handleWizardState(m, userState) {
    switch (userState.state) {
        case 'waiting_payment_method':
            await handlePaymentMethod(m, userState);
            break;
        case 'waiting_product_data':
            await handleProductData(m, userState);
            break;
        case 'waiting_delete_product':
            await handleDeleteProduct(m, userState);
            break;
        case 'waiting_edit_product_select':
            await handleEditProductSelect(m, userState);
            break;
        case 'waiting_edit_product_field':
            await handleEditProductField(m, userState);
            break;
        case 'waiting_edit_product_value':
            await handleEditProductValue(m, userState);
            break;
        default:
            global.userStates.delete(m.senderNumber);
            break;
    }
}

async function handlePaymentMethod(m, userState) {
    const choice = m.body.toLowerCase().trim();

    if (choice === 'batal') {
        global.userStates.delete(m.senderNumber);
        return await m.reply('❌ Pembelian dibatalkan!');
    }

    const lockKey = `payment_${m.senderNumber}_${userState.productId}`;
    if (global.processingLocks.has(lockKey)) {
        return await m.reply('⏳ Sedang memproses... mohon tunggu.');
    }

    global.processingLocks.set(lockKey, true);

    try {
        const product = await db.getProduct(userState.productId);
        if (!product || product.stok_tersisa === 0) {
            global.userStates.delete(m.senderNumber);
            global.processingLocks.delete(lockKey);
            return await m.reply('❌ Produk tidak tersedia!');
        }

        const user = await db.getUser(m.senderNumber);

        if (choice === '1') {
            if (user.saldo < product.harga) {
                global.processingLocks.delete(lockKey);
                return await m.reply(`❌ Saldo tidak cukup!

💵 Saldo kamu: ${helper.formatRupiah(user.saldo)}
💰 Harga produk: ${helper.formatRupiah(product.harga)}
📉 Kurang: ${helper.formatRupiah(product.harga - user.saldo)}

💡 Top up dulu: *${config.PREFIX}topup*`);
            }

            await processPaymentWithSaldo(m, product, user);
            global.userStates.delete(m.senderNumber);
            global.processingLocks.delete(lockKey);

        } else if (choice === '2') {
            try {
                await m.reply('🔄 Membuat pembayaran QRIS...');

                const deposit = await payment.createDeposit(product.harga);
                const qrBuffer = Buffer.from(deposit.qr_image.split(',')[1], 'base64');

                const caption = `╭━━━『 💳 PEMBAYARAN QRIS 』━━━╮
│
│ 📚 Produk: ${product.nama}
│ 💰 Total: ${helper.formatRupiah(product.harga)}
│ ⏰ Batas: 5 menit
│ 🆔 ID: ${deposit.id}
│
╰━━━━━━━━━━━━━━━━━━╯

📱 *Cara Bayar:*
1. Scan QR code di atas
2. Bayar sesuai nominal
3. Link otomatis terkirim!

⏳ Mengecek pembayaran otomatis...`;

                await m.replyWithImage(qrBuffer, caption);
                startPaymentCheck(m, deposit.id, product.id, 0);
                global.userStates.delete(m.senderNumber);
                global.processingLocks.delete(lockKey);

            } catch (error) {
                console.error('Error creating QRIS payment:', error);
                await m.reply('❌ Gagal membuat pembayaran! Coba lagi nanti.');
                global.userStates.delete(m.senderNumber);
                global.processingLocks.delete(lockKey);
            }
        } else {
            global.processingLocks.delete(lockKey);
            await m.reply('❌ Pilihan tidak valid! Reply dengan *1* atau *2*');
        }
    } catch (error) {
        console.error('Payment method error:', error);
        global.processingLocks.delete(lockKey);
        global.userStates.delete(m.senderNumber);
        await m.reply('❌ Terjadi kesalahan! Silakan coba lagi.');
    }
}

async function handleProductData(m, userState) {
    const messageType = getContentType(m.msg.message);

    if (messageType !== 'imageMessage') {
        return await m.reply('❌ Kirim gambar produk dengan caption format yang benar!');
    }

    const caption = m.msg.message.imageMessage.caption || '';
    const lines = caption.split('\n').filter(line => line.trim());

    if (lines.length < 4) {
        return await m.reply('❌ Format tidak lengkap! Minimal harus ada: Nama, Harga, Deskripsi, dan Link');
    }

    const nama = lines[0].trim();
    const harga = parseInt(lines[1].trim());
    const deskripsi = lines[2].trim();
    const links = lines.slice(3).filter(link => link.trim());

    if (isNaN(harga) || harga <= 0) {
        return await m.reply('❌ Harga harus angka positif!');
    }

    if (links.length === 0) {
        return await m.reply('❌ Minimal harus ada 1 link download!');
    }

    try {
        const buffer = await m.sock.downloadMediaMessage(m.msg);
        
        if (!buffer || buffer.length === 0) {
            throw new Error('Failed to download image');
        }

        const product = await db.addProduct({
            nama,
            harga,
            deskripsi,
            gambar: buffer.toString('base64'),
            links
        });

        await m.reply(`✅ Produk berhasil ditambahkan!

📚 Nama: ${product.nama}
💰 Harga: ${helper.formatRupiah(product.harga)}
📦 Stok: ${product.stok_tersisa}
🆔 ID: ${product.id}`);

        global.userStates.delete(m.senderNumber);

    } catch (error) {
        console.error('Error adding product:', error);
        await m.reply('❌ Gagal menambah produk! Pastikan format dan gambar benar.');
        global.userStates.delete(m.senderNumber);
    }
}

async function handleDeleteProduct(m, userState) {
    const productId = m.body.trim();
    const product = await db.getProduct(productId);

    if (!product) {
        return await m.reply('❌ Produk tidak ditemukan! Kirim ID yang benar.');
    }

    const deleted = await db.deleteProduct(productId);
    
    if (deleted) {
        await m.reply(`✅ Produk berhasil dihapus!

📚 Nama: ${product.nama}
💰 Harga: ${helper.formatRupiah(product.harga)}`);
    } else {
        await m.reply('❌ Gagal menghapus produk!');
    }

    global.userStates.delete(m.senderNumber);
}

async function handleEditProductSelect(m, userState) {
    const productId = m.body.trim();
    const product = await db.getProduct(productId);

    if (!product) {
        return await m.reply('❌ Produk tidak ditemukan! Kirim ID yang benar.');
    }

    const editText = `✏️ *EDIT PRODUK*

📚 ${product.nama}
💰 ${helper.formatRupiah(product.harga)}

Pilih yang mau diedit:
1️⃣ Nama
2️⃣ Harga
3️⃣ Deskripsi
4️⃣ Tambah Link

Reply dengan nomor pilihan (1-4)`;

    await m.reply(editText);

    global.userStates.set(m.senderNumber, {
        state: 'waiting_edit_product_field',
        productId: productId,
        timestamp: Date.now()
    });
}

async function handleEditProductField(m, userState) {
    const choice = m.body.trim();
    const product = await db.getProduct(userState.productId);

    let field = '';
    let prompt = '';

    switch (choice) {
        case '1':
            field = 'nama';
            prompt = '📝 Kirim nama produk baru:';
            break;
        case '2':
            field = 'harga';
            prompt = '💰 Kirim harga baru (angka saja):';
            break;
        case '3':
            field = 'deskripsi';
            prompt = '📋 Kirim deskripsi baru:';
            break;
        case '4':
            field = 'links';
            prompt = '🔗 Kirim link baru (bisa kirim multiple, pisah dengan enter):';
            break;
        default:
            return await m.reply('❌ Pilihan tidak valid! Reply dengan 1-4');
    }

    await m.reply(prompt);

    global.userStates.set(m.senderNumber, {
        state: 'waiting_edit_product_value',
        productId: userState.productId,
        field: field,
        timestamp: Date.now()
    });
}

async function handleEditProductValue(m, userState) {
    const value = m.body.trim();
    const products = await db.getProducts();
    const index = products.findIndex(p => p.id === userState.productId);

    if (index === -1) {
        global.userStates.delete(m.senderNumber);
        return await m.reply('❌ Produk tidak ditemukan!');
    }

    switch (userState.field) {
        case 'nama':
            products[index].nama = value;
            break;

        case 'harga':
            const harga = parseInt(value);
            if (isNaN(harga) || harga <= 0) {
                return await m.reply('❌ Harga harus angka positif!');
            }
            products[index].harga = harga;
            break;

        case 'deskripsi':
            products[index].deskripsi = value;
            break;

        case 'links':
            const newLinks = value.split('\n').filter(link => link.trim());
            products[index].links.push(...newLinks);
            products[index].stok_tersisa += newLinks.length;
            break;
    }

    await db.saveProducts(products);
    await m.reply(`✅ Produk berhasil diupdate!

📚 ${products[index].nama}
💰 ${helper.formatRupiah(products[index].harga)}
📦 Stok: ${products[index].stok_tersisa}`);

    global.userStates.delete(m.senderNumber);
}

async function processPaymentWithSaldo(m, product, user) {
    const lockKey = `process_${m.senderNumber}_${product.id}`;
    
    if (global.processingLocks.has(lockKey)) {
        return;
    }

    global.processingLocks.set(lockKey, true);

    try {
        const users = await db.getUsers();
        const userIndex = users.findIndex(u => u.id === m.senderNumber);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }

        if (users[userIndex].saldo < product.harga) {
            global.processingLocks.delete(lockKey);
            return await m.reply('❌ Saldo tidak cukup!');
        }

        users[userIndex].saldo -= product.harga;
        users[userIndex].totalTransactions = (users[userIndex].totalTransactions || 0) + 1;
        await db.saveUsers(users);

        const products = await db.getProducts();
        const productIndex = products.findIndex(p => p.id === product.id);
        
        if (productIndex === -1 || products[productIndex].stok_tersisa === 0) {
            users[userIndex].saldo += product.harga;
            users[userIndex].totalTransactions -= 1;
            await db.saveUsers(users);
            global.processingLocks.delete(lockKey);
            return await m.reply('❌ Produk tidak tersedia! Saldo dikembalikan.');
        }

        const link = products[productIndex].links.shift();
        products[productIndex].stok_tersisa--;
        products[productIndex].terjual++;
        await db.saveProducts(products);

        const order = {
            id: helper.generateId('ORDER'),
            userId: m.senderNumber,
            userName: m.pushname,
            productId: product.id,
            productName: product.nama,
            price: product.harga,
            link: link,
            status: 'success',
            paymentMethod: 'saldo',
            createdAt: new Date().toISOString()
        };
        await db.saveOrder(order);

        const successMsg = `╭━━━『 ✅ PEMBELIAN SUKSES 』━━━╮
│
│ 📚 Produk: ${product.nama}
│ 💰 Harga: ${helper.formatRupiah(product.harga)}
│ 💵 Sisa Saldo: ${helper.formatRupiah(users[userIndex].saldo)}
│ ⏰ Waktu: ${helper.getWIBDateTime()}
│
├━━━『 LINK DOWNLOAD 』━━━
│ 🔗 ${link}
│
╰━━━━━━━━━━━━━━━━━━╯

⚠️ *PENTING:*
- Link download hanya dikirim 1x
- Simpan link dengan baik
- Screenshot pesan ini

🙏 Terima kasih sudah berbelanja!`;

        await m.reply(successMsg);
        await sendChannelNotification(m, product, link, 'saldo');

        global.processingLocks.delete(lockKey);

    } catch (error) {
        console.error('Error processing payment with saldo:', error);
        global.processingLocks.delete(lockKey);
        await m.reply('❌ Terjadi error saat memproses pembayaran!');
    }
}

function startPaymentCheck(m, depositId, productId, attempt) {
    if (attempt >= config.MAX_CHECK_ATTEMPTS) {
        const timer = global.paymentTimers.get(depositId);
        if (timer) clearTimeout(timer);
        global.paymentTimers.delete(depositId);
        m.reply('⏰ Pembayaran expired! Silakan buat pembayaran baru.');
        return;
    }

    const timerId = setTimeout(async () => {
        try {
            const status = await payment.checkDepositStatus(depositId);

            if (status.status === 'success' || status.status === 'paid') {
                const timer = global.paymentTimers.get(depositId);
                if (timer) clearTimeout(timer);
                global.paymentTimers.delete(depositId);
                await processSuccessfulPayment(m, productId, depositId);
            } else if (status.status === 'expired') {
                const timer = global.paymentTimers.get(depositId);
                if (timer) clearTimeout(timer);
                global.paymentTimers.delete(depositId);
                await m.reply('⏰ Pembayaran expired! Silakan buat pembayaran baru.');
            } else {
                startPaymentCheck(m, depositId, productId, attempt + 1);
            }
        } catch (error) {
            console.error('Error checking payment:', error);
            if (attempt < config.MAX_CHECK_ATTEMPTS) {
                startPaymentCheck(m, depositId, productId, attempt + 1);
            } else {
                const timer = global.paymentTimers.get(depositId);
                if (timer) clearTimeout(timer);
                global.paymentTimers.delete(depositId);
            }
        }
    }, config.CHECK_INTERVAL);

    global.paymentTimers.set(depositId, timerId);
}

function startTopupCheck(m, depositId, attempt) {
    if (attempt >= config.MAX_CHECK_ATTEMPTS) {
        const timer = global.paymentTimers.get(depositId);
        if (timer) clearTimeout(timer);
        global.paymentTimers.delete(depositId);
        m.reply('⏰ Top-up expired! Silakan buat pembayaran baru.');
        return;
    }

    const timerId = setTimeout(async () => {
        try {
            const status = await payment.checkDepositStatus(depositId);

            if (status.status === 'success' || status.status === 'paid') {
                const timer = global.paymentTimers.get(depositId);
                if (timer) clearTimeout(timer);
                global.paymentTimers.delete(depositId);
                await processSuccessfulTopup(m, depositId, status);
            } else if (status.status === 'expired') {
                const timer = global.paymentTimers.get(depositId);
                if (timer) clearTimeout(timer);
                global.paymentTimers.delete(depositId);
                await m.reply('⏰ Top-up expired! Silakan buat pembayaran baru.');
            } else {
                startTopupCheck(m, depositId, attempt + 1);
            }
        } catch (error) {
            console.error('Error checking topup:', error);
            if (attempt < config.MAX_CHECK_ATTEMPTS) {
                startTopupCheck(m, depositId, attempt + 1);
            } else {
                const timer = global.paymentTimers.get(depositId);
                if (timer) clearTimeout(timer);
                global.paymentTimers.delete(depositId);
            }
        }
    }, config.CHECK_INTERVAL);

    global.paymentTimers.set(depositId, timerId);
}

async function processSuccessfulPayment(m, productId, depositId) {
    const lockKey = `deposit_${depositId}`;
    
    if (global.processingLocks.has(lockKey)) {
        return;
    }

    global.processingLocks.set(lockKey, true);

    try {
        if (global.processedDeposits.has(depositId)) {
            console.log(`Deposit ${depositId} already processed`);
            global.processingLocks.delete(lockKey);
            return await m.reply('✅ Pembayaran ini sudah diproses sebelumnya!');
        }

        global.processedDeposits.set(depositId, { productId, userId: m.senderNumber });
        await db.saveProcessedDeposit(depositId, productId, m.senderNumber);

        const product = await db.getProduct(productId);
        if (!product || product.stok_tersisa === 0) {
            global.processingLocks.delete(lockKey);
            await m.reply('❌ Maaf stok habis! Hubungi owner untuk refund.');
            return;
        }

        const products = await db.getProducts();
        const productIndex = products.findIndex(p => p.id === productId);
        const link = products[productIndex].links.shift();
        products[productIndex].stok_tersisa--;
        products[productIndex].terjual++;
        await db.saveProducts(products);

        const users = await db.getUsers();
        const userIndex = users.findIndex(u => u.id === m.senderNumber);
        if (userIndex !== -1) {
            users[userIndex].totalTransactions = (users[userIndex].totalTransactions || 0) + 1;
            await db.saveUsers(users);
        }

        const order = {
            id: helper.generateId('ORDER'),
            userId: m.senderNumber,
            userName: m.pushname,
            productId: product.id,
            productName: product.nama,
            price: product.harga,
            link: link,
            status: 'success',
            paymentMethod: 'qris',
            depositId: depositId,
            createdAt: new Date().toISOString()
        };
        await db.saveOrder(order);

        const successMsg = `╭━━━『 ✅ PEMBAYARAN SUKSES 』━━━╮
│
│ 📚 Produk: ${product.nama}
│ 💰 Harga: ${helper.formatRupiah(product.harga)}
│ ⏰ Waktu: ${helper.getWIBDateTime()}
│
├━━━『 LINK DOWNLOAD 』━━━
│ 🔗 ${link}
│
╰━━━━━━━━━━━━━━━━━━╯

⚠️ *PENTING:*
- Link download hanya dikirim 1x
- Simpan link dengan baik
- Screenshot pesan ini

🙏 Terima kasih sudah berbelanja!`;

        await m.reply(successMsg);
        await sendChannelNotification(m, product, link, 'qris');

        global.processingLocks.delete(lockKey);

    } catch (error) {
        console.error('Error processing successful payment:', error);
        global.processedDeposits.delete(depositId);
        global.processingLocks.delete(lockKey);
        await m.reply('❌ Terjadi error saat memproses pembayaran!');
    }
}

async function processSuccessfulTopup(m, depositId, status) {
    try {
        const users = await db.getUsers();
        const userIndex = users.findIndex(u => u.id === m.senderNumber);

        if (userIndex !== -1) {
            users[userIndex].saldo += status.get_balance || status.nominal;
            await db.saveUsers(users);

            await m.reply(`╭━━━『 ✅ TOP-UP SUKSES 』━━━╮
│
│ 💰 Nominal: ${helper.formatRupiah(status.nominal)}
│ 💵 Saldo Ditambah: ${helper.formatRupiah(status.get_balance || status.nominal)}
│ 💳 Saldo Sekarang: ${helper.formatRupiah(users[userIndex].saldo)}
│ ⏰ Waktu: ${helper.getWIBDateTime()}
│
╰━━━━━━━━━━━━━━━━━━╯

🎉 Terima kasih!
Saldo sudah bisa digunakan untuk beli ebook.`);
        }
    } catch (error) {
        console.error('Error processing successful topup:', error);
        await m.reply('❌ Terjadi error saat memproses top-up!');
    }
}

async function sendChannelNotification(m, product, link, paymentMethod) {
    if (!config.CHANNEL_ID) return;

    try {
        const caption = `╭━━━『 ✅ TRANSAKSI BARU 』━━━╮
│
│ 👤 User: ${helper.sensorUsername(m.pushname)}
│ 🆔 ID: ${helper.sensorId(m.senderNumber)}
│ 📚 Produk: ${helper.sensorProductName(product.nama)}
│ 💰 Harga: ${helper.formatRupiah(product.harga)}
│ 💳 Metode: ${paymentMethod.toUpperCase()}
│ 🔗 Link: ${helper.sensorLink(link)}
│ ⏰ Waktu: ${helper.getWIBDateTime()}
│
╰━━━━━━━━━━━━━━━━━━╯

🤖 ${config.BOT_NAME}`;

        if (product.gambar) {
            const buffer = Buffer.from(product.gambar, 'base64');
            await m.sock.sendMessage(config.CHANNEL_ID, {
                image: buffer,
                caption: caption
            });
        } else {
            await m.sock.sendMessage(config.CHANNEL_ID, { text: caption });
        }
    } catch (error) {
        console.error('Error sending channel notification:', error);
    }
}

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    db.logError(error, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    db.logError(new Error(reason), 'Unhandled Rejection');
});

startBot().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
});
