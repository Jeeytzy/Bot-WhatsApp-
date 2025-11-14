module.exports = {
    // Owner Configuration
    OWNER_NUMBER: '6281234567890', // Ganti dengan nomor owner (format: 62xxx)
    OWNER_NAME: 'Jeeyhosting',
    BOT_NAME: 'Ebook Store Bot',
    
    // Channel/Group untuk notifikasi transaksi
    CHANNEL_ID: '120363123456789@g.us', // ID Group WhatsApp (bisa dikosongkan jika tidak ada)
    
    // Payment Gateway Configuration
    PAYMENT_API_KEY: 'ciaa-79ec32d1bfb38fb56f0f9c878d38b27f',
    API_BASE_URL: 'https://ciaatopup.my.id',
    
    // Bot Settings
    PREFIX: '.',
    PAYMENT_TIMEOUT: 300000, // 5 menit
    CHECK_INTERVAL: 10000, // 10 detik
    MAX_CHECK_ATTEMPTS: 30,
    
    // Database Files
    SESSION_FOLDER: './session',
    PRODUCTS_FILE: './database/dataproduk.json',
    USERS_FILE: './database/datauser.json',
    ORDERS_FILE: './database/dataorder.json',
    PROCESSED_DEPOSITS_FILE: './database/prosesdepost.json',
    ERROR_LOG: './logs/error.log',
    
    // Banner
    BANNER_URL: 'https://files.catbox.moe/9pivb2.jpg'
};