import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load the .env file from the workspace root (one level up from dist/extension.js)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

export interface UserStats {
    github_id: string;
    custom_username: string | null;
    current_status: string | null;
    current_language: string | null;
    daily_streak: number;
    total_seconds_this_month: number;
    total_seconds_today: number;
    last_active_date: string; // YYYY-MM-DD
    last_streak_increment_date: string | null; // YYYY-MM-DD
    language_stats: Record<string, number>; // Language -> seconds
}

export interface MonthlyArchive {
    id: number;
    github_id: string;
    month_identifier: string; // YYYY-MM
    total_seconds: number;
    top_languages: Record<string, number>;
}

export class DatabaseService {
    private pool: Pool | null = null;
    private initialized = false;

    constructor() {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            console.error('PiperCode: DATABASE_URL environment variable is missing.');
            return;
        }

        try {
            // Parse using the modern WHATWG URL API to prevent url.parse deprecation warnings inside pg client parser
            const dbUrl = new URL(connectionString);
            this.pool = new Pool({
                user: decodeURIComponent(dbUrl.username),
                password: decodeURIComponent(dbUrl.password),
                host: dbUrl.hostname,
                port: dbUrl.port ? parseInt(dbUrl.port, 10) : 5432,
                database: decodeURIComponent(dbUrl.pathname.slice(1)),
                ssl: {
                    rejectUnauthorized: false
                },
                max: 5,
                connectionTimeoutMillis: 5000,
                idleTimeoutMillis: 30000
            });
        } catch (error: any) {
            console.error('PiperCode: Failed to create PG connection pool:', error.message);
        }
    }

    public isConnected(): boolean {
        return this.pool !== null;
    }

    /**
     * Initializes the database by dropping stale tables and recreating with the correct schema.
     */
    public async initialize(): Promise<boolean> {
        if (!this.pool) return false;
        if (this.initialized) return true;

        try {
            const client = await this.pool.connect();
            try {
                // Drop old tables to fix schema mismatches from previous versions
                await client.query('DROP TABLE IF EXISTS monthly_archive CASCADE;');
                await client.query('DROP TABLE IF EXISTS users CASCADE;');

                // Users Table
                await client.query(`
                    CREATE TABLE IF NOT EXISTS users (
                        github_id VARCHAR(255) PRIMARY KEY,
                        custom_username VARCHAR(255),
                        current_status VARCHAR(255),
                        current_language VARCHAR(255),
                        daily_streak INTEGER DEFAULT 0,
                        total_seconds_this_month INTEGER DEFAULT 0,
                        total_seconds_today INTEGER DEFAULT 0,
                        last_active_date DATE DEFAULT CURRENT_DATE,
                        last_streak_increment_date DATE,
                        language_stats JSONB DEFAULT '{}'::jsonb
                    );
                `);

                // Monthly Archive Table
                await client.query(`
                    CREATE TABLE IF NOT EXISTS monthly_archive (
                        id SERIAL PRIMARY KEY,
                        github_id VARCHAR(255) NOT NULL,
                        month_identifier VARCHAR(7) NOT NULL,
                        total_seconds INTEGER DEFAULT 0,
                        top_languages JSONB DEFAULT '{}'::jsonb,
                        CONSTRAINT fk_user FOREIGN KEY (github_id) REFERENCES users(github_id) ON DELETE CASCADE
                    );
                `);

                // Follows Table (Friends)
                await client.query(`
                    CREATE TABLE IF NOT EXISTS follows (
                        follower_id VARCHAR(255) NOT NULL,
                        target_id VARCHAR(255) NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (follower_id, target_id),
                        CONSTRAINT fk_follower FOREIGN KEY (follower_id) REFERENCES users(github_id) ON DELETE CASCADE,
                        CONSTRAINT fk_target FOREIGN KEY (target_id) REFERENCES users(github_id) ON DELETE CASCADE
                    );
                `);

                console.log('PiperCode: Database schemas verified and initialized.');
                this.initialized = true;
                return true;
            } finally {
                client.release();
            }
        } catch (error: any) {
            console.error('PiperCode: Database initialization failed:', error.message);
            return false;
        }
    }

    /**
     * Fetch user record. If they don't exist, create them.
     */
    public async getUser(githubId: string): Promise<UserStats | null> {
        if (!this.pool) return null;
        await this.initialize();

        try {
            const res = await this.pool.query('SELECT * FROM users WHERE github_id = $1', [githubId]);
            if (res.rows.length > 0) {
                const row = res.rows[0];
                return {
                    github_id: row.github_id,
                    custom_username: row.custom_username,
                    current_status: row.current_status,
                    current_language: row.current_language,
                    daily_streak: Number(row.daily_streak),
                    total_seconds_this_month: Number(row.total_seconds_this_month),
                    total_seconds_today: Number(row.total_seconds_today),
                    last_active_date: this.formatDate(row.last_active_date),
                    last_streak_increment_date: row.last_streak_increment_date ? this.formatDate(row.last_streak_increment_date) : null,
                    language_stats: row.language_stats || {}
                };
            }

            // Create user since they do not exist
            const insertRes = await this.pool.query(
                `INSERT INTO users (github_id, daily_streak, total_seconds_this_month, total_seconds_today, last_active_date, language_stats)
                 VALUES ($1, 0, 0, 0, CURRENT_DATE, '{}'::jsonb) RETURNING *`,
                [githubId]
            );
            const row = insertRes.rows[0];
            return {
                github_id: row.github_id,
                custom_username: row.custom_username,
                current_status: row.current_status,
                current_language: row.current_language,
                daily_streak: Number(row.daily_streak),
                total_seconds_this_month: Number(row.total_seconds_this_month),
                total_seconds_today: Number(row.total_seconds_today),
                last_active_date: this.formatDate(row.last_active_date),
                last_streak_increment_date: null,
                language_stats: row.language_stats || {}
            };
        } catch (error: any) {
            console.error(`PiperCode: Failed to get/create user ${githubId}:`, error.message);
            return null;
        }
    }

    /**
     * Update/set custom username
     */
    public async updateUsername(githubId: string, customUsername: string): Promise<boolean> {
        if (!this.pool) return false;
        await this.initialize();

        try {
            // Ensure username is trimmed and not empty
            const name = customUsername.trim().substring(0, 30);
            await this.pool.query('UPDATE users SET custom_username = $1 WHERE github_id = $2', [name, githubId]);
            return true;
        } catch (error: any) {
            console.error(`PiperCode: Failed to update username for ${githubId}:`, error.message);
            return false;
        }
    }

    /**
     * Broadcast status message & active language
     */
    public async updateStatus(githubId: string, status: string, language: string): Promise<boolean> {
        if (!this.pool) return false;
        await this.initialize();

        try {
            await this.pool.query(
                'UPDATE users SET current_status = $1, current_language = $2 WHERE github_id = $3',
                [status.trim().substring(0, 100), language, githubId]
            );
            return true;
        } catch (error: any) {
            console.error(`PiperCode: Failed to update status for ${githubId}:`, error.message);
            return false;
        }
    }

    /**
     * Sync coding activity. Handles daily streak calculations and monthly rollover.
     */
    public async syncActivity(
        githubId: string,
        secondsToAdd: number,
        language: string,
        thresholdMinutes: number
    ): Promise<UserStats | null> {
        if (!this.pool) return null;
        await this.initialize();

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const res = await client.query('SELECT * FROM users WHERE github_id = $1 FOR UPDATE', [githubId]);
            if (res.rows.length === 0) {
                // User should exist by now. Rollback, release handled by finally block.
                await client.query('ROLLBACK');
                return await this.getUser(githubId);
            }

            const row = res.rows[0];
            let dailyStreak = Number(row.daily_streak);
            let totalSecondsThisMonth = Number(row.total_seconds_this_month);
            let totalSecondsToday = Number(row.total_seconds_today);
            let lastActiveDateStr = this.formatDate(row.last_active_date);
            let lastStreakIncrementDateStr = row.last_streak_increment_date ? this.formatDate(row.last_streak_increment_date) : null;
            let languageStats = row.language_stats || {};

            const today = new Date();
            const todayStr = this.getLocalDateString(today);
            const currentMonthStr = this.getLocalMonthString(today);

            const activeDate = new Date(row.last_active_date);
            const activeMonthStr = this.getLocalMonthString(activeDate);

            // 1. Monthly Rollover check: If the last active date's month differs from today's month
            if (activeMonthStr !== currentMonthStr) {
                // Archive previous month's data
                await client.query(
                    `INSERT INTO monthly_archive (github_id, month_identifier, total_seconds, top_languages)
                     VALUES ($1, $2, $3, $4)`,
                    [githubId, activeMonthStr, totalSecondsThisMonth, languageStats]
                );

                // Reset for the new month
                totalSecondsThisMonth = 0;
                languageStats = {};
                totalSecondsToday = 0;
            }

            // 2. Daily rollover check: If last active date is not today
            if (lastActiveDateStr !== todayStr) {
                totalSecondsToday = 0;
            }

            // 3. Add metrics
            totalSecondsThisMonth += secondsToAdd;
            totalSecondsToday += secondsToAdd;
            languageStats[language] = (languageStats[language] || 0) + secondsToAdd;

            // 4. Streak processing
            const thresholdSeconds = thresholdMinutes * 60;
            if (totalSecondsToday >= thresholdSeconds) {
                if (lastStreakIncrementDateStr !== todayStr) {
                    const yesterdayStr = this.getYesterdayDateString(today);
                    if (lastStreakIncrementDateStr === yesterdayStr) {
                        dailyStreak += 1;
                    } else {
                        // Streak broken, reset to 1
                        dailyStreak = 1;
                    }
                    lastStreakIncrementDateStr = todayStr;
                }
            }

            // 5. Update user table
            const updateRes = await client.query(
                `UPDATE users 
                 SET daily_streak = $1, 
                     total_seconds_this_month = $2, 
                     total_seconds_today = $3, 
                     last_active_date = $4, 
                     last_streak_increment_date = $5, 
                     language_stats = $6,
                     current_language = $7
                 WHERE github_id = $8
                 RETURNING *`,
                [
                    dailyStreak,
                    totalSecondsThisMonth,
                    totalSecondsToday,
                    todayStr,
                    lastStreakIncrementDateStr,
                    JSON.stringify(languageStats),
                    language,
                    githubId
                ]
            );

            await client.query('COMMIT');

            const updatedRow = updateRes.rows[0];
            return {
                github_id: updatedRow.github_id,
                custom_username: updatedRow.custom_username,
                current_status: updatedRow.current_status,
                current_language: updatedRow.current_language,
                daily_streak: Number(updatedRow.daily_streak),
                total_seconds_this_month: Number(updatedRow.total_seconds_this_month),
                total_seconds_today: Number(updatedRow.total_seconds_today),
                last_active_date: this.formatDate(updatedRow.last_active_date),
                last_streak_increment_date: updatedRow.last_streak_increment_date ? this.formatDate(updatedRow.last_streak_increment_date) : null,
                language_stats: updatedRow.language_stats || {}
            };

        } catch (error: any) {
            await client.query('ROLLBACK');
            console.error(`PiperCode: Transaction failed for syncActivity of ${githubId}:`, error.message);
            return null;
        } finally {
            client.release();
        }
    }

    /**
     * Get global developer leaderboard sorted by active month hours
     */
    public async getLeaderboard(): Promise<any[]> {
        if (!this.pool) return [];
        await this.initialize();

        try {
            const res = await this.pool.query(
                `SELECT github_id, custom_username, current_status, current_language, daily_streak, total_seconds_this_month, last_active_date
                 FROM users
                 ORDER BY total_seconds_this_month DESC
                 LIMIT 50`
            );
            return res.rows.map(row => ({
                github_id: row.github_id,
                name: row.custom_username || row.github_id,
                current_status: row.current_status,
                current_language: row.current_language,
                daily_streak: Number(row.daily_streak),
                total_seconds_this_month: Number(row.total_seconds_this_month),
                last_active_date: this.formatDate(row.last_active_date)
            }));
        } catch (error: any) {
            console.error('PiperCode: Failed to fetch leaderboard:', error.message);
            return [];
        }
    }

    /**
     * Get archived performances of past months
     */
    public async getMonthlyArchives(githubId: string): Promise<MonthlyArchive[]> {
        if (!this.pool) return [];
        await this.initialize();

        try {
            const res = await this.pool.query(
                `SELECT id, month_identifier, total_seconds, top_languages
                 FROM monthly_archive
                 WHERE github_id = $1
                 ORDER BY month_identifier DESC`,
                [githubId]
            );
            return res.rows.map(row => ({
                id: row.id,
                github_id: githubId,
                month_identifier: row.month_identifier,
                total_seconds: Number(row.total_seconds),
                top_languages: row.top_languages || {}
            }));
        } catch (error: any) {
            console.error(`PiperCode: Failed to fetch monthly archives for ${githubId}:`, error.message);
            return [];
        }
    }

    /**
     * Search for users by custom_username (case-insensitive partial match).
     * Excludes the searching user.
     */
    public async searchUsers(query: string, currentUserId: string): Promise<any[]> {
        if (!this.pool || !query || query.trim().length < 2) return [];
        await this.initialize();

        try {
            const searchTerm = `%${query.trim()}%`;
            const res = await this.pool.query(
                `SELECT github_id, custom_username, current_status, current_language, daily_streak
                 FROM users
                 WHERE custom_username ILIKE $1 AND github_id != $2
                 LIMIT 10`,
                [searchTerm, currentUserId]
            );
            return res.rows.map(row => ({
                github_id: row.github_id,
                name: row.custom_username || row.github_id,
                current_status: row.current_status,
                current_language: row.current_language,
                daily_streak: Number(row.daily_streak)
            }));
        } catch (error: any) {
            console.error('PiperCode: Failed to search users:', error.message);
            return [];
        }
    }

    /**
     * Follow a user
     */
    public async followUser(followerId: string, targetId: string): Promise<boolean> {
        if (!this.pool) return false;
        await this.initialize();

        try {
            await this.pool.query(
                `INSERT INTO follows (follower_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [followerId, targetId]
            );
            return true;
        } catch (error: any) {
            console.error('PiperCode: Failed to follow user:', error.message);
            return false;
        }
    }

    /**
     * Unfollow a user
     */
    public async unfollowUser(followerId: string, targetId: string): Promise<boolean> {
        if (!this.pool) return false;
        await this.initialize();

        try {
            await this.pool.query(
                `DELETE FROM follows WHERE follower_id = $1 AND target_id = $2`,
                [followerId, targetId]
            );
            return true;
        } catch (error: any) {
            console.error('PiperCode: Failed to unfollow user:', error.message);
            return false;
        }
    }

    /**
     * Get live stats of everyone the user follows
     */
    public async getFriendsList(githubId: string): Promise<any[]> {
        if (!this.pool) return [];
        await this.initialize();

        try {
            const res = await this.pool.query(
                `SELECT u.github_id, u.custom_username, u.current_status, u.current_language, u.daily_streak, u.total_seconds_this_month, u.last_active_date
                 FROM users u
                 JOIN follows f ON u.github_id = f.target_id
                 WHERE f.follower_id = $1
                 ORDER BY u.total_seconds_this_month DESC`,
                [githubId]
            );
            return res.rows.map(row => ({
                github_id: row.github_id,
                name: row.custom_username || row.github_id,
                current_status: row.current_status,
                current_language: row.current_language,
                daily_streak: Number(row.daily_streak),
                total_seconds_this_month: Number(row.total_seconds_this_month),
                last_active_date: this.formatDate(row.last_active_date)
            }));
        } catch (error: any) {
            console.error('PiperCode: Failed to fetch friends list:', error.message);
            return [];
        }
    }

    // Helper: Dates formatting to YYYY-MM-DD
    private formatDate(dateVal: any): string {
        const d = new Date(dateVal);
        return this.getLocalDateString(d);
    }

    private getLocalDateString(d: Date): string {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    private getLocalMonthString(d: Date): string {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        return `${year}-${month}`;
    }

    private getYesterdayDateString(d: Date): string {
        const yesterday = new Date(d);
        yesterday.setDate(d.getDate() - 1);
        return this.getLocalDateString(yesterday);
    }
}
