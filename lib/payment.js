const axios = require('axios');
const config = require('../config');

class PaymentGateway {
    constructor() {
        this.headers = {
            'X-APIKEY': config.PAYMENT_API_KEY
        };
    }

    async createDeposit(nominal, metode = 'QRISFAST') {
        try {
            const response = await axios.get(`${config.API_BASE_URL}/h2h/deposit/create`, {
                params: { nominal, metode },
                headers: this.headers,
                timeout: 15000
            });

            if (response.data.success) {
                return response.data.data;
            } else {
                throw new Error(response.data.message || 'Failed to create deposit');
            }
        } catch (error) {
            if (error.response) {
                throw new Error(error.response.data.message || 'API Error');
            }
            throw error;
        }
    }

    async checkDepositStatus(depositId) {
        try {
            const response = await axios.get(`${config.API_BASE_URL}/h2h/deposit/status`, {
                params: { id: depositId },
                headers: this.headers,
                timeout: 15000
            });

            if (response.data.success) {
                return response.data.data;
            } else {
                throw new Error(response.data.message || 'Failed to check status');
            }
        } catch (error) {
            if (error.response) {
                throw new Error(error.response.data.message || 'API Error');
            }
            throw error;
        }
    }
}

module.exports = new PaymentGateway();