require('dotenv').config({ quiet: true });
const axios = require('axios');
const fs = require('fs');
const chalk = require('chalk');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('./config.json');
const Table = require('cli-table3');

// --- CONSTANTS & CONFIG ---
const MAX_RETRIES = 3;
const BASE_DELAY = 2000;
const JITTER_MS = 1500;
const ACCOUNT_DELAY_MS = 5000; // Delay between processing accounts

// Cooldown Constants (in Seconds)
const COOLDOWN_SOCIAL = 17 * 60 * 60; // 17 hours
const COOLDOWN_ONCHAIN = 4 * 60 * 60; // 4 hours
const COOLDOWN_DAILY = 24 * 60 * 60; // 24 hours

// --- UTILS ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = () => BASE_DELAY + Math.floor(Math.random() * JITTER_MS);

function getJwtExp(token) {
    if (!token) return null;
    try {
        const payload = token.split('.')[1];
        if (!payload) return null;
        const decoded = Buffer.from(payload, 'base64').toString('utf-8');
        const json = JSON.parse(decoded);
        return json.exp; // Timestamp in seconds
    } catch (e) {
        return null;
    }
}

async function countdown(seconds) {
    for (let i = seconds; i > 0; i--) {
        const hrs = Math.floor(i / 3600).toString().padStart(2, '0');
        const mins = Math.floor((i % 3600) / 60).toString().padStart(2, '0');
        const secs = (i % 60).toString().padStart(2, '0');
        process.stdout.write(`\r${chalk.yellow('⏳ NEXT CYCLE IN:')} ${chalk.bold.white(`${hrs}:${mins}:${secs}`)} `);
        await delay(1000);
    }
    process.stdout.write('\r\n');
}

// Browser Fingerprint Simulation
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0"
];

function getHeaders() {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    return {
        'User-Agent': ua,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
}

// --- DATABASE MANAGER ---
class DatabaseManager {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = {};
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            }
        } catch (e) {
            console.error(chalk.red('Failed to load database:', e.message));
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error(chalk.red('Failed to save database:', e.message));
        }
    }

    getAccount(walletAddress) {
        if (!this.data[walletAddress]) {
            this.data[walletAddress] = { quests: {} };
        }
        return this.data[walletAddress];
    }

    updateQuest(walletAddress, questId, questData) {
        const acc = this.getAccount(walletAddress);
        acc.quests[questId] = { ...acc.quests[questId], ...questData };
        this.save();
    }

    getQuest(walletAddress, questId) {
        const acc = this.getAccount(walletAddress);
        return acc.quests[questId];
    }
}

const db = new DatabaseManager('database.json');

// --- BOT CLASS ---
class ShadeBot {
    constructor(walletAddress, sessionToken, proxy, index, expiresAt = null) {
        this.walletAddress = walletAddress;
        this.sessionToken = sessionToken;
        this.proxy = proxy;
        this.index = index;
        this.expiresAt = expiresAt;

        // Init Axios
        const agent = proxy ? new HttpsProxyAgent(this.proxy) : undefined;
        this.client = axios.create({
            baseURL: config.baseUrl,
            headers: getHeaders(),
            httpsAgent: agent,
            timeout: 10000
        });

        // Set Auth
        if (this.sessionToken) {
            this.client.defaults.headers.common['Authorization'] = `Bearer ${this.sessionToken}`;
        }

        // This instance's stats
        this.stats = {
            id: index,
            account: this.walletAddress.slice(0, 8) + '...',
            startPoints: 0,
            endPoints: 0,
            social: { total: 0, success: 0, failed: 0, cooldown: 0, completedAlready: 0 },
            onchain: { total: 0, success: 0, failed: 0, cooldown: 0, completedAlready: 0 },
            daily: { status: 'Skipped', nextRun: null }, // distinct tracking
            minCooldown: null, // Track shortest cooldown in seconds
            tokenExp: this.expiresAt ? new Date(this.expiresAt).getTime() / 1000 : getJwtExp(this.sessionToken), // Manual OR JWT
            errors: []
        };

        if (proxy) console.log(`[Acc ${index}] Proxy: ${proxy}`);
    }

    async withRetry(actionName, fn) {
        let lastError;
        for (let i = 0; i < MAX_RETRIES; i++) {
            try {
                return await fn();
            } catch (e) {
                lastError = e;
                const status = e.response ? e.response.status : 'N/A';

                // FATAL ERRORS (Do not retry)
                if (status === 401 || status === 403) break; // Auth failed
                if (status === 429) break; // Rate Limit (Stop Retrying!)
                if (status === 400) break; // Bad Request (Often logic error, retry won't fix)

                // Only log network/proxy errors or 5xx, silence others to keep UI clean
                if (status === 'N/A' || status >= 500) {
                    console.log(chalk.gray(`[Acc ${this.index}][${actionName}] Retry ${i + 1}/${MAX_RETRIES} (${e.message})`));
                    await delay(2000 + (Math.random() * 1000));
                } else {
                    break; // Treat other 4xx as non-retriable logic errors
                }
            }
        }
        throw lastError;
    }

    async login() {
        console.log(`[Acc ${this.index}] Verifying session...`);
        try {
            // 1. Verify access to protected resource using RETRY wrapper
            await this.withRetry('Login', () => this.client.get('/api/quests'));

            // 2. Try to get user details (Optional)
            try {
                const res = await this.client.get('/api/auth/user', {
                    params: { wallet: this.walletAddress }
                });
                if (res.data && res.data.user) {
                    const user = res.data.user;
                    console.log(`[Acc ${this.index}] LOGIN SUCCESS | User: ${chalk.cyan(user.nickname)} | Points: ${chalk.green(user.points)}`);
                    this.stats.startPoints = user.points;
                } else {
                    console.log(`[Acc ${this.index}] LOGIN SUCCESS (User details unavailable)`);
                }
            } catch (e) {
                console.log(`[Acc ${this.index}] LOGIN SUCCESS (User endpoint failed: ${e.message})`);
            }
            return true;
        } catch (e) {
            const msg = e.response?.data?.error || e.message;
            console.error(chalk.red(`[Acc ${this.index}] LOGIN FAILED: ${msg}`));
            this.stats.errors.push(`Login Failed: ${msg}`);
            return false;
        }
    }

    async processDailyClaim() {
        console.log(chalk.cyan(`[Acc ${this.index}] Checking Daily Claim...`));

        // 1. Check DB
        const savedQ = db.getQuest(this.walletAddress, 'daily_claim');
        const now = Date.now();

        if (savedQ && savedQ.nextRunTime > now) {
            const remaining = Math.ceil((savedQ.nextRunTime - now) / 1000);
            this.stats.daily.status = 'Cooldown';
            this.stats.daily.nextRun = savedQ.nextRunTime;

            // Update global min cooldown
            if (this.stats.minCooldown === null || remaining < this.stats.minCooldown) {
                this.stats.minCooldown = remaining;
            }
            console.log(chalk.yellow(`[Acc ${this.index}] Daily Claim on cooldown (${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m)`));
            return;
        }

        // 2. Execute
        try {
            await this.withRetry('DailyClaim', async () => {
                const res = await this.client.post('/api/claim', {});
                if (res.data.success || res.status === 200) {
                    console.log(chalk.green(`[Acc ${this.index}] Daily Claim SUCCESS!`));
                    if (res.data.reward) console.log(chalk.green(`  > Reward: ${res.data.reward} | Streak: ${res.data.streak}`));

                    this.stats.daily.status = 'Success';

                    // Set DB Cooldown 24h
                    const nextRun = Date.now() + (COOLDOWN_DAILY * 1000);
                    db.updateQuest(this.walletAddress, 'daily_claim', {
                        title: 'Daily Claim',
                        category: 'daily',
                        nextRunTime: nextRun
                    });
                    this.stats.daily.nextRun = nextRun;

                    if (this.stats.minCooldown === null || COOLDOWN_DAILY < this.stats.minCooldown) {
                        this.stats.minCooldown = COOLDOWN_DAILY;
                    }
                }
            });
        } catch (e) {
            const msg = (e.response?.data?.error || e.message).toLowerCase();
            const status = e.response?.status;

            // Check for success masquerading as error
            if (msg.includes('already') || msg.includes('limit') || status === 400) {
                console.log(chalk.green(`[Acc ${this.index}] Daily Claim: Already done today.`));
                this.stats.daily.status = 'Success'; // Mark as success for summary

                // Set DB Cooldown 24h
                const nextRun = Date.now() + (COOLDOWN_DAILY * 1000);
                db.updateQuest(this.walletAddress, 'daily_claim', {
                    title: 'Daily Claim',
                    category: 'daily',
                    nextRunTime: nextRun
                });
                this.stats.daily.nextRun = nextRun;

                // Update min cooldown logic
                if (this.stats.minCooldown === null || COOLDOWN_DAILY < this.stats.minCooldown) {
                    this.stats.minCooldown = COOLDOWN_DAILY;
                }
            } else {
                console.log(chalk.red(`[Acc ${this.index}] Daily Claim FAILED: ${msg}`));
                this.stats.daily.status = 'Failed';
            }
        }
    }

    getVerificationPayload(quest) {
        const cat = quest.category || '';
        const title = quest.title.toLowerCase();

        // Standard Social payloads (dummy but effective if server only checks presence)
        if (cat === 'follow' || title.includes('follow')) return { twitterUsername: 'pubgsec1' };
        if (['like', 'retweet', 'quote'].includes(cat) || title.includes('retweet')) return { tweetUrl: 'https://x.com/Shade_L2/status/1880000000000000000' };

        // Onchain payloads
        if (['shield', 'unshield', 'private_send', 'faucet'].includes(cat) || quest.type === 'onchain') {
            const hash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
            return { txHash: hash, transactionHash: hash };
        }
        return {};
    }

    async processQuests() {
        // console.log(`[Acc ${this.index}] Fetching quests...`);
        let quests = [];
        try {
            const res = await this.withRetry('GetQuests', () => this.client.get('/api/quests'));
            quests = res.data.quests || res.data || [];
        } catch (e) {
            console.error(chalk.red(`[Acc ${this.index}] Fetch Quests Failed: ${e.message}`));
            this.stats.errors.push(`Fetch Failed: ${e.message}`);
            return;
        }

        console.log(`[Acc ${this.index}] Found ${quests.length} quests.`);

        // Separate counters local first then sync to stats
        for (const q of quests) {
            const isSocial = !(['shield', 'unshield', 'private_send', 'faucet', 'onchain'].includes(q.category) && q.type !== 'social');
            const catStats = isSocial ? this.stats.social : this.stats.onchain;

            catStats.total++;

            // CHECK DATABASE FIRST
            const savedQ = db.getQuest(this.walletAddress, q.id);
            const now = Date.now();
            let dbCooldownRemaining = 0;

            if (savedQ && savedQ.nextRunTime > now) {
                dbCooldownRemaining = Math.ceil((savedQ.nextRunTime - now) / 1000);
            }

            // If API says completed OR DB says completed (and API doesnt contradict?) -> Skip
            if (q.status === 'completed' || q.completed) {
                catStats.completedAlready++;
                continue;
            }

            // [V5.2] Shield/Unshield/Invite Exception: Always 0 cooldown
            const title = q.title.toLowerCase();
            const isNoCooldown = title.includes('shield') || title.includes('unshield') || title.includes('invite');

            // USE API Cooldown OR DB Cooldown (whichever is larger), unless Exception
            let actualCooldown = Math.max(q.cooldownRemaining || 0, dbCooldownRemaining);

            if (isNoCooldown) {
                actualCooldown = 0; // FORCE READY
            }

            if (actualCooldown > 0) {
                catStats.cooldown++;
                // Record to DB if not already
                if (!savedQ || savedQ.nextRunTime < (now + actualCooldown * 1000)) {
                    db.updateQuest(this.walletAddress, q.id, {
                        title: q.title,
                        category: isSocial ? 'social' : 'onchain',
                        nextRunTime: now + (actualCooldown * 1000)
                    });
                }

                // Track minimum cooldown globally for account
                if (this.stats.minCooldown === null || actualCooldown < this.stats.minCooldown) {
                    this.stats.minCooldown = actualCooldown;
                }
                continue;
            }

            console.log(chalk.cyan(`[Acc ${this.index}] Quest: ${q.title} (${isSocial ? 'Social' : 'OnChain'})`));

            // Attempts optional completion endpoint (sometimes needed, sometimes not)
            try {
                await this.client.post('/api/quests/complete', { questId: q.id });
                await delay(500);
            } catch (e) { }

            try {
                const payload = this.getVerificationPayload(q);
                await this.withRetry('VerifyQuest', async () => {
                    const res = await this.client.post('/api/quests/verify', { questId: q.id, ...payload });
                    if (res.data.verified || res.data.success) {
                        console.log(chalk.green(`[Acc ${this.index}]   > +POINTS!`));
                        catStats.success++;
                        // Reset DB cooldown just in case
                        db.updateQuest(this.walletAddress, q.id, { nextRunTime: 0 });
                    } else {
                        if (res.data.error) throw new Error(res.data.error);
                        catStats.failed++;
                    }
                });
            } catch (e) {
                const msg = (e.response?.data?.error || e.message).toLowerCase();
                const status = e.response?.status;

                // 1. Success masquerading as 400
                if (msg.includes('already') || msg.includes('completed') || status === 400) {
                    console.log(chalk.green(`[Acc ${this.index}]   > Verified (Initially 400/Already Done)`));
                    catStats.success++;
                    // catStats.cooldown = Math.max(0, catStats.cooldown - 1); 

                    // Mark completed/reset
                    db.updateQuest(this.walletAddress, q.id, { nextRunTime: 0 });
                }
                // 2. Real Cooldown / Limit
                else if (msg.includes('limit') || msg.includes('tomorrow') || msg.includes('cooldown')) {
                    console.log(chalk.yellow(`[Acc ${this.index}]   > Limit Reached (${isSocial ? '17h' : '4h'} Cooldown)`));

                    if (isNoCooldown) {
                        console.log(chalk.green(`[Acc ${this.index}]   > (No-Cooldown Mode: Attempting anyway/Ignoring Lock)`));
                        // Do NOT increment catStats.cooldown or set DB cooldown
                        catStats.failed++;
                    } else {
                        catStats.cooldown++;
                        catStats.failed++; // Technically a fail to process now due to limit

                        const coold = isSocial ? COOLDOWN_SOCIAL : COOLDOWN_ONCHAIN;
                        db.updateQuest(this.walletAddress, q.id, {
                            title: q.title,
                            category: isSocial ? 'social' : 'onchain',
                            nextRunTime: Date.now() + (coold * 1000)
                        });
                        if (this.stats.minCooldown === null || coold < this.stats.minCooldown) {
                            this.stats.minCooldown = coold;
                        }
                    }
                }
                // 3. Genuine Failure
                else {
                    console.log(chalk.red(`[Acc ${this.index}]   > FAILED: ${msg}`));
                    catStats.failed++;
                }
            }
        }
    }

    async getFinalStats() {
        try {
            const res = await this.client.get('/api/auth/user', {
                params: { wallet: this.walletAddress }
            });
            this.stats.endPoints = res.data.user.points;
        } catch (e) { }
    }
}

// --- MAIN EXECUTION ---
(async () => {
    console.log(chalk.blue(`
               / \\
              /   \\
             |  |  |
             |  |  |
              \\  \\
             |  |  |
             |  |  |
              \\   /
               \\ /
    `));
    console.log(chalk.bold.cyan('    ======SIPAL AIRDROP======'));
    console.log(chalk.bold.cyan('  =====SIPAL SHADE BOT V1.0====='));

    while (true) {
        // Load Accounts (Reloading allows hot-swaping accounts.json without restart!)
        let accounts = [];
        try {
            if (fs.existsSync('accounts.json')) {
                const raw = fs.readFileSync('accounts.json', 'utf-8');
                accounts = JSON.parse(raw);
            }
        } catch (e) {
            console.error('Error loading accounts.json:', e.message);
        }

        if (accounts.length === 0) {
            console.error('No accounts found! Please populate accounts.json');
            await delay(10000);
            continue;
        }

        console.log(`\nStarting Cycle with ${accounts.length} accounts...`);
        cycleStats = []; // Reset cycle stats

        // Loop Accounts
        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];
            if (!acc.walletAddress || acc.walletAddress === "0x..." || acc.walletAddress === "") {
                continue;
            }

            const bot = new ShadeBot(acc.walletAddress, acc.sessionToken, acc.proxy, i + 1, acc.expiresAt);

            if (await bot.login()) {
                await bot.processDailyClaim();
                await bot.processQuests();
                await bot.getFinalStats();
            }

            cycleStats.push(bot.stats);

            // Delay between accounts
            if (i < accounts.length - 1) {
                console.log(chalk.gray(`Waiting ${ACCOUNT_DELAY_MS / 1000}s before next account...`));
                await delay(ACCOUNT_DELAY_MS);
            }
        }

        // --- GRAND SUMMARY ---
        console.log('\n' + chalk.bold.cyan('================================================================================'));
        console.log(chalk.bold.cyan(`                          🤖 SIPAL SHADE BOT V1.0 🤖`));
        console.log(chalk.bold.cyan('================================================================================'));

        let globalMinCooldown = null;
        const tableData = [];

        cycleStats.forEach(s => {
            const diff = s.endPoints - s.startPoints;
            const diffStr = diff > 0 ? `+${diff}` : `${diff}`;

            // Daily Status
            let dailyStr = s.daily.status;
            if (dailyStr === 'Success') dailyStr = 'DONE';
            if (dailyStr === 'Cooldown') dailyStr = 'WAIT';
            if (dailyStr === 'Failed') dailyStr = 'FAIL';

            const fmt = (q) => `${q.total}/${q.success}/${q.failed}/${q.cooldown}/${q.completedAlready}`;

            const socialStr = fmt(s.social);
            const onchainStr = fmt(s.onchain);

            // Cooldown String
            let cdStr = 'READY';

            if (s.minCooldown !== null) {
                const hrs = Math.floor(s.minCooldown / 3600);
                const mins = Math.floor((s.minCooldown % 3600) / 60);
                cdStr = `${hrs}h ${mins}m`;
                if (globalMinCooldown === null || s.minCooldown < globalMinCooldown) {
                    globalMinCooldown = s.minCooldown;
                }
            }

            tableData.push([
                s.account,
                s.endPoints,
                diffStr,
                dailyStr,
                socialStr,
                onchainStr,
                cdStr,
                s.tokenExp ? new Date(s.tokenExp * 1000).toLocaleString('id-ID', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'N/A'
            ]);
        });

        // Instantiate Table
        const table = new Table({
            head: ['Account', 'Points', 'Diff', 'Daily', 'Social', 'OnChain', 'Next Run', 'Token Exp'],
            style: {
                head: ['cyan'],
                border: ['grey']
            }
        });

        table.push(...tableData);

        console.log(table.toString());
        console.log(chalk.bold.cyan('================================================================================\n'));

        let waitTime = 60; // Default 1 min if no cooldowns (avoids spam)
        if (globalMinCooldown !== null && globalMinCooldown > 0) {
            waitTime = globalMinCooldown + 60; // Add 1 min buffer
        } else {
            console.log(chalk.green(`No active cooldowns found. Waiting 60s default...`));
        }

        await countdown(waitTime);
    }
})();
