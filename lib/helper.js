const moment = require('moment-timezone');

module.exports = {
    // Format Rupiah
    formatRupiah(number) {
        return 'Rp ' + number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    },

    // Sensor ID
    sensorId(id) {
        const str = id.toString();
        return str.length > 5 ? str.substring(0, str.length - 5) + '*****' : str;
    },

    // Sensor Username
    sensorUsername(username) {
        if (!username) return 'Unknown***';
        return username.length > 5 ? username.substring(0, username.length - 3) + '***' : username + '***';
    },

    // Sensor Product Name
    sensorProductName(nama) {
        return nama.length > 4 ? nama.substring(0, nama.length - 4) + '****' : nama;
    },

    // Sensor Link
    sensorLink(link) {
        if (link.includes('drive.google.com')) {
            return 'https://drive.google.com/***';
        }
        return link.length > 20 ? link.substring(0, 20) + '***' : link;
    },

    // Get WIB DateTime
    getWIBDateTime() {
        return moment.tz('Asia/Jakarta').format('DD/MM/YYYY, HH:mm') + ' WIB';
    },

    // Get JID from number
    getJid(number) {
        return number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    },

    // Extract number from JID
    extractNumber(jid) {
        return jid.split('@')[0];
    },

    // Sleep function
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    // Generate random ID
    generateId(prefix = 'ID') {
        return `${prefix}${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
};