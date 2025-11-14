const fs = require('fs-extra');
const path = require('path');
const config = require('../config');

class Database {
    constructor() {
        this.initDatabase();
    }

    async initDatabase() {
        // Create database folder if not exists
        await fs.ensureDir('./database');
        await fs.ensureDir('./logs');
        
        // Initialize files
        const files = [
            config.PRODUCTS_FILE,
            config.USERS_FILE,
            config.ORDERS_FILE,
            config.PROCESSED_DEPOSITS_FILE
        ];

        for (const file of files) {
            if (!await fs.pathExists(file)) {
                await fs.writeJson(file, []);
            }
        }
    }

    // Products
    async getProducts() {
        try {
            return await fs.readJson(config.PRODUCTS_FILE);
        } catch (error) {
            console.error('Error loading products:', error);
            return [];
        }
    }

    async saveProducts(products) {
        try {
            await fs.writeJson(config.PRODUCTS_FILE, products, { spaces: 2 });
            return true;
        } catch (error) {
            console.error('Error saving products:', error);
            return false;
        }
    }

    async getProduct(productId) {
        const products = await this.getProducts();
        return products.find(p => p.id === productId);
    }

    async addProduct(productData) {
        const products = await this.getProducts();
        const newProduct = {
            id: `ebook${Date.now()}`,
            ...productData,
            stok_tersisa: productData.links.length,
            terjual: 0,
            createdAt: new Date().toISOString()
        };
        products.push(newProduct);
        await this.saveProducts(products);
        return newProduct;
    }

    async updateProduct(productId, updateData) {
        const products = await this.getProducts();
        const index = products.findIndex(p => p.id === productId);
        if (index !== -1) {
            products[index] = { ...products[index], ...updateData };
            await this.saveProducts(products);
            return products[index];
        }
        return null;
    }

    async deleteProduct(productId) {
        const products = await this.getProducts();
        const filtered = products.filter(p => p.id !== productId);
        if (filtered.length !== products.length) {
            await this.saveProducts(filtered);
            return true;
        }
        return false;
    }

    // Users
    async getUsers() {
        try {
            return await fs.readJson(config.USERS_FILE);
        } catch (error) {
            console.error('Error loading users:', error);
            return [];
        }
    }

    async saveUsers(users) {
        try {
            await fs.writeJson(config.USERS_FILE, users, { spaces: 2 });
            return true;
        } catch (error) {
            console.error('Error saving users:', error);
            return false;
        }
    }

    async getUser(userId) {
        const users = await this.getUsers();
        return users.find(u => u.id === userId);
    }

    async createUser(userData) {
        const users = await this.getUsers();
        const existing = users.find(u => u.id === userData.id);
        
        if (!existing) {
            const newUser = {
                id: userData.id,
                name: userData.name || 'User',
                saldo: 0,
                joinDate: new Date().toISOString(),
                totalTransactions: 0
            };
            users.push(newUser);
            await this.saveUsers(users);
            return newUser;
        }
        return existing;
    }

    async updateUserSaldo(userId, amount) {
        const users = await this.getUsers();
        const index = users.findIndex(u => u.id === userId);
        if (index !== -1) {
            users[index].saldo += amount;
            users[index].totalTransactions = (users[index].totalTransactions || 0) + 1;
            await this.saveUsers(users);
            return users[index];
        }
        return null;
    }

    // Orders
    async getOrders() {
        try {
            return await fs.readJson(config.ORDERS_FILE);
        } catch (error) {
            console.error('Error loading orders:', error);
            return [];
        }
    }

    async saveOrder(orderData) {
        try {
            const orders = await this.getOrders();
            orders.push(orderData);
            await fs.writeJson(config.ORDERS_FILE, orders, { spaces: 2 });
            return true;
        } catch (error) {
            console.error('Error saving order:', error);
            return false;
        }
    }

    async getUserOrders(userId) {
        const orders = await this.getOrders();
        return orders.filter(o => o.userId === userId);
    }

    // Processed Deposits
    async getProcessedDeposits() {
        try {
            const data = await fs.readJson(config.PROCESSED_DEPOSITS_FILE);
            const map = new Map();
            data.forEach(d => map.set(d.depositId, d));
            return map;
        } catch (error) {
            console.error('Error loading processed deposits:', error);
            return new Map();
        }
    }

    async saveProcessedDeposit(depositId, productId, userId) {
        try {
            const deposits = await fs.readJson(config.PROCESSED_DEPOSITS_FILE);
            deposits.push({
                depositId,
                productId,
                userId,
                processedAt: new Date().toISOString()
            });
            await fs.writeJson(config.PROCESSED_DEPOSITS_FILE, deposits, { spaces: 2 });
            return true;
        } catch (error) {
            console.error('Error saving processed deposit:', error);
            return false;
        }
    }

    // Error Logging
    async logError(error, context) {
        try {
            const logEntry = `[${new Date().toISOString()}] ${context}: ${error.message}\n${error.stack}\n\n`;
            await fs.appendFile(config.ERROR_LOG, logEntry);
        } catch (err) {
            console.error('Error logging error:', err);
        }
    }
}

module.exports = new Database();
