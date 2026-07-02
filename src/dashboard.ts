import * as vscode from 'vscode';
import { DatabaseService, UserStats } from './database';
import { AuthenticationManager } from './auth';
import { ActivityTracker } from './tracker';

export class DashboardPanel {
    public static currentPanel: DashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _disposed = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private context: vscode.ExtensionContext,
        private dbService: DatabaseService,
        private authManager: AuthenticationManager,
        private tracker: ActivityTracker
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Set the webview's initial html content
        this.updateHtml();

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'signIn':
                        const success = await this.authManager.signIn();
                        if (success) {
                            this.tracker.forceReloadStats();
                        }
                        this.updateHtml();
                        break;
                    case 'signOut':
                        await this.authManager.signOut();
                        this.tracker.forceReloadStats();
                        this.updateHtml();
                        break;
                    case 'updateUsername':
                        if (!this.authManager.isGuest()) {
                            const githubId = this.authManager.getGitHubId();
                            if (githubId) {
                                await this.dbService.updateUsername(githubId, message.username);
                                vscode.window.showInformationMessage(`Username updated to "${message.username}"!`);
                            }
                        } else {
                            // Update local guest username
                            this.context.globalState.update('pipercode.guest.customUsername', message.username);
                            vscode.window.showInformationMessage(`Guest username updated to "${message.username}"!`);
                        }
                        this.updateHtml();
                        break;
                    case 'updateStatus':
                        const status = message.status;
                        await this.context.globalState.update('pipercode.userStatus', status);
                        const githubId = this.authManager.getGitHubId();
                        if (githubId && this.dbService.isConnected()) {
                            await this.dbService.updateStatus(githubId, status, this.tracker.getLanguage());
                        }
                        vscode.window.showInformationMessage(`Status broadcast updated to: "${status}"`);
                        this.updateHtml();
                        break;
                    case 'addTask':
                        const tasks = this.context.globalState.get<string[]>('pipercode.tasks') || [];
                        if (message.task.trim()) {
                            tasks.push(message.task.trim());
                            await this.context.globalState.update('pipercode.tasks', tasks);
                        }
                        this.updateHtml();
                        break;
                    case 'deleteTask':
                        const currentTasks = this.context.globalState.get<string[]>('pipercode.tasks') || [];
                        const updatedTasks = currentTasks.filter((_, idx) => idx !== message.index);
                        await this.context.globalState.update('pipercode.tasks', updatedTasks);
                        this.updateHtml();
                        break;
                    case 'searchUsers':
                        if (this.authManager.isGuest()) {
                            vscode.window.showWarningMessage('Sign in with GitHub to search for other developers!');
                            return;
                        }
                        const githubIdSearch = this.authManager.getGitHubId();
                        if (githubIdSearch && this.dbService.isConnected()) {
                            const results = await this.dbService.searchUsers(message.query, githubIdSearch);
                            this._panel.webview.postMessage({ command: 'searchResults', results });
                        }
                        break;
                    case 'followUser':
                        const followerId = this.authManager.getGitHubId();
                        if (followerId && this.dbService.isConnected()) {
                            await this.dbService.followUser(followerId, message.targetId);
                            vscode.window.showInformationMessage(`Followed developer!`);
                            this.updateHtml();
                        }
                        break;
                    case 'unfollowUser':
                        const unfollowerId = this.authManager.getGitHubId();
                        if (unfollowerId && this.dbService.isConnected()) {
                            await this.dbService.unfollowUser(unfollowerId, message.targetId);
                            vscode.window.showInformationMessage(`Unfollowed developer.`);
                            this.updateHtml();
                        }
                        break;
                }
            },
            null,
            this._disposables
        );

        // Listen for stats updates from the tracker
        this.tracker.registerOnStatsUpdated(() => {
            this.updateHtml();
        });
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        dbService: DatabaseService,
        authManager: AuthenticationManager,
        tracker: ActivityTracker
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel._panel.reveal(column);
            DashboardPanel.currentPanel.updateHtml();
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'pipercodeDashboard',
            'PiperCode Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        DashboardPanel.currentPanel = new DashboardPanel(
            panel,
            extensionUri,
            context,
            dbService,
            authManager,
            tracker
        );
    }

    public async updateHtml() {
        if (this._disposed) return;
        try {
            this._panel.webview.html = await this.getHtmlForWebview();
        } catch (e) {
            // Panel may have been disposed between the check and the assignment
        }
    }

    private async getHtmlForWebview(): Promise<string> {
        const githubId = this.authManager.getGitHubId();
        const isGuest = this.authManager.isGuest();
        const githubUsername = this.authManager.getGitHubUsername();

        let customUsername = '';
        let todayTime = 0;
        let monthTime = 0;
        let dailyStreak = 0;
        let currentStatus = this.context.globalState.get<string>('pipercode.userStatus') || 'Coding...';
        let languageStats: Record<string, number> = {};
        let leaderboard: any[] = [];
        let archives: any[] = [];
        let friends: any[] = [];

        if (!isGuest && githubId && this.dbService.isConnected()) {
            // Authenticated Mode: Load from database
            const user = await this.dbService.getUser(githubId);
            if (user) {
                customUsername = user.custom_username || '';
                todayTime = user.total_seconds_today;
                monthTime = user.total_seconds_this_month;
                dailyStreak = user.daily_streak;
                languageStats = user.language_stats || {};
            }
            leaderboard = await this.dbService.getLeaderboard();
            archives = await this.dbService.getMonthlyArchives(githubId);
            friends = await this.dbService.getFriendsList(githubId);
        } else {
            // Guest Mode: Load from local state
            customUsername = this.context.globalState.get<string>('pipercode.guest.customUsername') || '';
            todayTime = this.context.globalState.get<number>('pipercode.guest.todayTime') || 0;
            monthTime = this.context.globalState.get<number>('pipercode.guest.monthTime') || 0;
            dailyStreak = this.context.globalState.get<number>('pipercode.guest.streak') || 0;
            languageStats = this.context.globalState.get<Record<string, number>>('pipercode.guest.languages') || {};
            archives = this.context.globalState.get<any[]>('pipercode.guest.archives') || [];
        }

        const tasks = this.context.globalState.get<string[]>('pipercode.tasks') || [];

        // Format times
        const formatTimeHMS = (totalSeconds: number) => {
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        };

        const formatTimeFriendly = (totalSeconds: number) => {
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            if (h > 0) return `${h}h ${m}m`;
            return `${m}m`;
        };

        const activeStats = this.tracker.getActiveStats();

        // Calculate language percentages for charts
        let totalLangSeconds = Object.values(languageStats).reduce((a, b) => a + b, 0);
        if (totalLangSeconds === 0) totalLangSeconds = 1;

        const languagesHtml = Object.entries(languageStats)
            .sort((a, b) => b[1] - a[1])
            .map(([lang, sec], idx) => {
                const percent = Math.round((sec / totalLangSeconds) * 100);
                const colors = ['#FFE600', '#00E575', '#2B66FF', '#FF5C00', '#9E00FF'];
                const color = colors[idx % colors.length];
                return `
                    <div style="margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; font-weight: 700; margin-bottom: 4px;">
                            <span>${lang}</span>
                            <span class="mono">${formatTimeFriendly(sec)} (${percent}%)</span>
                        </div>
                        <div style="border: 2px solid #000; height: 20px; background: #fff; position: relative;">
                            <div style="background: ${color}; width: ${percent}%; height: 100%; border-right: ${percent > 0 ? '2px solid #000' : 'none'};"></div>
                        </div>
                    </div>
                `;
            }).join('');

        // Leaderboard rendering
        let leaderboardHtml = '';
        if (isGuest) {
            leaderboardHtml = `
                <div class="lock-overlay">
                    <div class="lock-icon">🔒</div>
                    <h3 style="margin: 12px 0 6px 0; font-weight: 900; text-transform: uppercase;">Leaderboard Locked</h3>
                    <p style="margin: 0; font-weight: 700; font-size: 13px;">Sign in with GitHub to compare stats and broadcast your status to the community!</p>
                </div>
            `;
        } else {
            leaderboardHtml = leaderboard.map((dev, idx) => {
                const isSelf = dev.github_id === githubId;
                const hours = (dev.total_seconds_this_month / 3600).toFixed(1);
                return `
                    <div class="leaderboard-row ${isSelf ? 'self-row' : ''}">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div class="rank-badge">${idx + 1}</div>
                                <div>
                                    <span style="font-weight: 900;">${dev.name}</span>
                                    <span style="font-size: 11px; background: #000; color: #fff; padding: 2px 6px; font-weight: 700; text-transform: uppercase; margin-left: 4px;">
                                        ${dev.current_language || 'Idle'}
                                    </span>
                                </div>
                            </div>
                            <div class="mono" style="font-weight: 700;">
                                ${hours}h | 🔥 ${dev.daily_streak}d
                            </div>
                        </div>
                        <div class="discord-note" style="margin-top: 6px;">
                            💬 ${dev.current_status || 'Coding hard...'}
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Friends rendering
        let friendsHtml = '';
        if (isGuest) {
            friendsHtml = `<div style="font-weight: 700; text-align: center; padding: 12px;">Sign in to follow friends!</div>`;
        } else if (friends.length === 0) {
            friendsHtml = `<div style="font-weight: 700; text-align: center; padding: 12px;">You aren't following anyone yet. Search above!</div>`;
        } else {
            friendsHtml = friends.map((dev) => {
                const hours = (dev.total_seconds_this_month / 3600).toFixed(1);
                return `
                    <div class="leaderboard-row">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div>
                                    <span style="font-weight: 900;">${dev.name}</span>
                                    <span style="font-size: 11px; background: #000; color: #fff; padding: 2px 6px; font-weight: 700; text-transform: uppercase; margin-left: 4px;">
                                        ${dev.current_language || 'Idle'}
                                    </span>
                                </div>
                            </div>
                            <div class="mono" style="font-weight: 700; display:flex; gap: 8px; align-items: center;">
                                <span>${hours}h | 🔥 ${dev.daily_streak}d</span>
                                <button class="btn btn-delete" onclick="unfollowUser('${dev.github_id}')">X</button>
                            </div>
                        </div>
                        <div class="discord-note" style="margin-top: 6px;">
                            💬 ${dev.current_status || 'Coding hard...'}
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Archives rendering
        const archivesHtml = archives.length > 0
            ? archives.map(arch => {
                const topLangs = Object.entries(arch.top_languages as Record<string, number>)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([l]) => l)
                    .join(', ') || 'None';

                return `
                    <div class="archive-row">
                        <div style="display: flex; justify-content: space-between; font-weight: 700; border-bottom: 2px solid #000; padding-bottom: 4px; margin-bottom: 4px;">
                            <span style="text-transform: uppercase;">📅 ${arch.month_identifier}</span>
                            <span class="mono">${formatTimeFriendly(arch.total_seconds)}</span>
                        </div>
                        <div style="font-size: 12px; font-weight: 700;">
                            Top Languages: <span class="mono" style="color: #2B66FF;">${topLangs}</span>
                        </div>
                    </div>
                `;
            }).join('')
            : '<div style="font-weight: 700; text-align: center; padding: 12px;">No historical archives found yet.</div>';

        // Tasks rendering
        const tasksHtml = tasks.map((task, idx) => `
            <div class="task-row">
                <span style="font-weight: 700;">${task}</span>
                <button class="btn btn-delete" onclick="deleteTask(${idx})">×</button>
            </div>
        `).join('');

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>PiperCode Dashboard</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;900&family=JetBrains+Mono:wght@400;700&display=swap');
                    
                    :root {
                        --bg-yellow: #FFE600;
                        --bg-blue: #2B66FF;
                        --bg-green: #00E575;
                        --bg-orange: #FF5C00;
                        --bg-purple: #9E00FF;
                        --border-color: #000000;
                        --text-color: #000000;
                    }

                    body {
                        background-image: radial-gradient(var(--border-color) 1px, transparent 0);
                        background-size: 24px 24px;
                        background-color: #F0F0F0;
                        font-family: 'Outfit', sans-serif;
                        margin: 0;
                        padding: 24px;
                        color: var(--text-color);
                    }

                    .dashboard-grid {
                        display: grid;
                        grid-template-columns: 2fr 1fr;
                        gap: 24px;
                    }

                    @media (max-width: 900px) {
                        .dashboard-grid {
                            grid-template-columns: 1fr;
                        }
                    }

                    /* Neo-Brutalist Card */
                    .card {
                        border: 4px solid var(--border-color);
                        background: #FFFFFF;
                        box-shadow: 8px 8px 0px var(--border-color);
                        padding: 24px;
                        margin-bottom: 24px;
                        position: relative;
                    }

                    .card-header-yellow {
                        background: var(--bg-yellow);
                        border-bottom: 4px solid var(--border-color);
                        margin: -24px -24px 20px -24px;
                        padding: 16px 24px;
                    }

                    .card-header-blue {
                        background: var(--bg-blue);
                        color: #FFFFFF;
                        border-bottom: 4px solid var(--border-color);
                        margin: -24px -24px 20px -24px;
                        padding: 16px 24px;
                    }

                    .card-title {
                        font-size: 24px;
                        font-weight: 900;
                        text-transform: uppercase;
                        margin: 0;
                        letter-spacing: 1px;
                    }

                    /* Header/Hero Section */
                    .hero-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        background: var(--bg-yellow);
                        border: 4px solid var(--border-color);
                        box-shadow: 8px 8px 0px var(--border-color);
                        padding: 24px;
                        margin-bottom: 28px;
                    }

                    .hero-title {
                        font-size: 40px;
                        font-weight: 900;
                        text-transform: uppercase;
                        margin: 0;
                        letter-spacing: -1px;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                    }

                    /* Neo-Brutalist Buttons */
                    .btn {
                        border: 3px solid var(--border-color);
                        background: #FFFFFF;
                        color: var(--text-color);
                        font-size: 14px;
                        font-weight: 900;
                        text-transform: uppercase;
                        cursor: pointer;
                        padding: 10px 18px;
                        box-shadow: 4px 4px 0px var(--border-color);
                        font-family: 'Outfit', sans-serif;
                        transition: transform 0.05s, box-shadow 0.05s;
                        display: inline-flex;
                        align-items: center;
                        gap: 8px;
                    }

                    .btn:hover {
                        transform: translate(-2px, -2px);
                        box-shadow: 6px 6px 0px var(--border-color);
                    }

                    .btn:active {
                        transform: translate(2px, 2px);
                        box-shadow: 2px 2px 0px var(--border-color);
                    }

                    .btn-yellow {
                        background: var(--bg-yellow);
                    }

                    .btn-blue {
                        background: var(--bg-blue);
                        color: #fff;
                    }

                    .btn-green {
                        background: var(--bg-green);
                    }

                    .btn-delete {
                        background: var(--bg-orange);
                        color: white;
                        padding: 2px 8px;
                        font-size: 16px;
                        box-shadow: 2px 2px 0px var(--border-color);
                    }

                    /* Text Input */
                    .input-group {
                        display: flex;
                        gap: 8px;
                        margin-bottom: 16px;
                    }

                    .input-text {
                        border: 3px solid var(--border-color);
                        background: #FFFFFF;
                        padding: 10px 14px;
                        font-family: 'Outfit', sans-serif;
                        font-weight: 700;
                        font-size: 14px;
                        flex-grow: 1;
                        outline: none;
                    }

                    .input-text:focus {
                        background: #FAFAFA;
                        border-color: var(--bg-blue);
                    }

                    /* Stats Panels */
                    .stats-container {
                        display: grid;
                        grid-template-columns: repeat(3, 1fr);
                        gap: 16px;
                        margin-bottom: 24px;
                    }

                    @media (max-width: 600px) {
                        .stats-container {
                            grid-template-columns: 1fr;
                        }
                    }

                    .stat-tile {
                        border: 3px solid var(--border-color);
                        padding: 16px;
                        box-shadow: 4px 4px 0px var(--border-color);
                        display: flex;
                        flex-direction: column;
                        justify-content: space-between;
                    }

                    .tile-yellow { background: var(--bg-yellow); }
                    .tile-blue { background: var(--bg-blue); color: #fff; }
                    .tile-white { background: #FFFFFF; }

                    .stat-value {
                        font-size: 32px;
                        font-weight: 900;
                        margin-top: 8px;
                    }

                    .stat-label {
                        font-size: 12px;
                        font-weight: 900;
                        text-transform: uppercase;
                        letter-spacing: 1px;
                        opacity: 0.9;
                    }

                    .mono {
                        font-family: 'JetBrains Mono', monospace;
                    }

                    /* Leaderboard List */
                    .leaderboard-row {
                        border: 3px solid var(--border-color);
                        background: #FFFFFF;
                        padding: 12px;
                        margin-bottom: 12px;
                        box-shadow: 4px 4px 0px var(--border-color);
                    }

                    .self-row {
                        background: #FFFCE0;
                        border-color: var(--bg-blue);
                    }

                    .rank-badge {
                        background: #000;
                        color: #fff;
                        width: 24px;
                        height: 24px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-weight: 900;
                        font-size: 12px;
                    }

                    .discord-note {
                        background: #F0F0F0;
                        border-left: 4px solid var(--border-color);
                        padding: 4px 8px;
                        font-size: 12px;
                        font-weight: 700;
                    }

                    /* Local Tasks */
                    .task-row {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        border: 2px solid var(--border-color);
                        padding: 8px 12px;
                        margin-bottom: 8px;
                        background: #FFF;
                    }

                    /* Locked overlay for guests */
                    .lock-overlay {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        border: 4px dashed var(--border-color);
                        padding: 32px 16px;
                        text-align: center;
                        background: #FAFAFA;
                    }

                    .lock-icon {
                        font-size: 40px;
                    }

                    /* Archives list */
                    .archive-row {
                        border: 2px solid var(--border-color);
                        padding: 10px;
                        margin-bottom: 10px;
                        background: #FFF;
                    }

                    /* Status indicator */
                    .status-indicator {
                        display: inline-block;
                        width: 12px;
                        height: 12px;
                        border: 2px solid #000;
                        border-radius: 50%;
                        margin-right: 6px;
                    }

                    .status-active { background: var(--bg-green); }
                    .status-idle { background: var(--bg-yellow); }
                </style>
            </head>
            <body>

                <!-- Hero Header -->
                <div class="hero-header">
                    <div>
                        <h1 class="hero-title">
                            🛸 PiperCode
                            <span style="font-size: 16px; background: #000; color: #FFF; padding: 4px 8px; font-weight: 700; text-transform: uppercase;">
                                v1.0.0
                            </span>
                        </h1>
                        <p style="margin: 8px 0 0 0; font-weight: 700; font-size: 15px;">
                            Logged in as: <strong class="mono">${githubUsername}</strong> 
                            ${isGuest ? '<span style="color: var(--bg-orange); font-weight:900;">(GUEST MODE)</span>' : '<span style="color: #2B66FF; font-weight:900;">(SYNCED)</span>'}
                        </p>
                    </div>
                    <div>
                        ${isGuest 
                            ? `<button class="btn btn-yellow" onclick="signIn()">🔌 Connect GitHub</button>`
                            : `<button class="btn" onclick="signOut()">🚪 Sign Out</button>`
                        }
                    </div>
                </div>

                <!-- Dashboard Content Layout -->
                <div class="dashboard-grid">

                    <!-- Left Column: Core tracking and Stats -->
                    <div>
                        <!-- Heartbeat state bar -->
                        <div class="card" style="padding: 14px 20px; display: flex; align-items: center; justify-content: space-between;">
                            <div style="display: flex; align-items: center; font-weight:700;">
                                <div class="status-indicator ${!activeStats.hasEverCoded ? 'status-idle' : activeStats.isIdle ? 'status-idle' : 'status-active'}"></div>
                                <span>Engine State: <strong>${!activeStats.hasEverCoded ? 'Ready (Open a code file)' : activeStats.isIdle ? 'Idle (Paused)' : 'Active (Tracking)'}</strong></span>
                            </div>
                            <div style="font-weight: 700;">
                                Language: <span class="mono" style="background:#000; color:#fff; padding:2px 6px;">${activeStats.currentLanguage}</span> | 
                                Project: <span style="text-decoration: underline;">${activeStats.currentProject}</span>
                            </div>
                        </div>

                        <!-- Stats Metrics Boxes -->
                        <div class="stats-container">
                            <div class="stat-tile tile-yellow">
                                <span class="stat-label">⏱️ Coded Today</span>
                                <span class="stat-value mono">${formatTimeHMS(activeStats.todaySeconds)}</span>
                            </div>
                            <div class="stat-tile tile-white">
                                <span class="stat-label">📅 Month Progress</span>
                                <span class="stat-value mono">${formatTimeFriendly(activeStats.monthSeconds)}</span>
                            </div>
                            <div class="stat-tile tile-blue">
                                <span class="stat-label">🔥 Daily Streak</span>
                                <span class="stat-value mono">${dailyStreak} days</span>
                            </div>
                        </div>

                        <!-- Language breakdown -->
                        <div class="card">
                            <div class="card-header-yellow">
                                <h2 class="card-title">💻 Language Breakdown</h2>
                            </div>
                            ${languagesHtml || '<div style="text-align: center; font-weight: 700; padding: 24px;">No coding languages logged yet. Keystroke to begin!</div>'}
                        </div>

                        <!-- Historic Archives -->
                        <div class="card">
                            <div class="card-header-blue">
                                <h2 class="card-title">📅 Historical Monthly Archives</h2>
                            </div>
                            <div style="max-height: 250px; overflow-y: auto; padding-right: 6px;">
                                ${archivesHtml}
                            </div>
                        </div>
                    </div>

                    <!-- Right Column: Community status & Tasks -->
                    <div>
                        <!-- Discord Status Broadcast -->
                        <div class="card">
                            <div class="card-header-yellow">
                                <h2 class="card-title">💬 Status Broadcast</h2>
                            </div>
                            <p style="margin: 0 0 12px 0; font-weight: 700; font-size: 13px;">
                                Set your current coding message to broadcast live alongside your language:
                            </p>
                            <div class="input-group">
                                <input type="text" id="statusInput" class="input-text" placeholder="What are you working on?" value="${currentStatus}">
                                <button class="btn btn-yellow" onclick="broadcastStatus()">Set</button>
                            </div>
                            <div class="discord-note" style="border-color: var(--bg-yellow)">
                                <strong>Live:</strong> "${currentStatus}"
                            </div>
                        </div>

                        <!-- Username Manager -->
                        <div class="card">
                            <div class="card-header-blue">
                                <h2 class="card-title">👤 Username Mask</h2>
                            </div>
                            <p style="margin: 0 0 12px 0; font-weight: 700; font-size: 13px;">
                                Mask your github username on the leaderboard:
                            </p>
                            <div class="input-group">
                                <input type="text" id="usernameInput" class="input-text" placeholder="Custom username" value="${customUsername}">
                                <button class="btn btn-blue" onclick="saveUsername()">Save</button>
                            </div>
                            ${isGuest ? '<div style="font-size:11px; font-weight: 700; color: var(--bg-orange);">⚠️ Note: Custom names are saved locally in Guest Mode.</div>' : ''}
                        </div>

                        <!-- Local Work Planner (Tasks) -->
                        <div class="card">
                            <div class="card-header-yellow">
                                <h2 class="card-title">📝 Work Planner</h2>
                            </div>
                            <div class="input-group">
                                <input type="text" id="taskInput" class="input-text" placeholder="New dashboard task...">
                                <button class="btn btn-yellow" onclick="addTask()">Add</button>
                            </div>
                            <div style="max-height: 200px; overflow-y: auto;">
                                ${tasksHtml || '<div style="font-weight: 700; text-align: center; opacity: 0.6; padding: 12px;">No active tasks. Add one above!</div>'}
                            </div>
                        </div>

                        <!-- Find Developers -->
                        <div class="card">
                            <div class="card-header-yellow">
                                <h2 class="card-title">🔍 Find Developers</h2>
                            </div>
                            <div class="input-group">
                                <input type="text" id="searchInput" class="input-text" placeholder="Search by username...">
                                <button class="btn btn-yellow" onclick="searchUsers()">Search</button>
                            </div>
                            <div id="searchResults" style="max-height: 200px; overflow-y: auto;">
                                <!-- Results injected dynamically -->
                            </div>
                        </div>

                        <!-- Friends List -->
                        <div class="card">
                            <div class="card-header-blue">
                                <h2 class="card-title">🤝 Friends List</h2>
                            </div>
                            <div style="max-height: 300px; overflow-y: auto; padding-right: 4px;">
                                ${friendsHtml}
                            </div>
                        </div>

                        <!-- Global Leaderboard -->
                        <div class="card">
                            <div class="card-header-blue">
                                <h2 class="card-title">🏆 Dev Leaderboard</h2>
                            </div>
                            <div style="max-height: 400px; overflow-y: auto; padding-right: 4px;">
                                ${leaderboardHtml}
                            </div>
                        </div>
                    </div>

                </div>

                <script>
                    const vscode = acquireVsCodeApi();

                    function signIn() {
                        vscode.postMessage({ command: 'signIn' });
                    }

                    function signOut() {
                        vscode.postMessage({ command: 'signOut' });
                    }

                    function saveUsername() {
                        const name = document.getElementById('usernameInput').value;
                        vscode.postMessage({ command: 'updateUsername', username: name });
                    }

                    function broadcastStatus() {
                        const statusVal = document.getElementById('statusInput').value;
                        vscode.postMessage({ command: 'updateStatus', status: statusVal });
                    }

                    function addTask() {
                        const taskVal = document.getElementById('taskInput').value;
                        if (taskVal.trim()) {
                            vscode.postMessage({ command: 'addTask', task: taskVal });
                            document.getElementById('taskInput').value = '';
                        }
                    }

                    function deleteTask(idx) {
                        vscode.postMessage({ command: 'deleteTask', index: idx });
                    }

                    function searchUsers() {
                        const query = document.getElementById('searchInput').value;
                        if (query.length >= 2) {
                            document.getElementById('searchResults').innerHTML = '<div style="font-weight: 700; padding: 8px;">Searching...</div>';
                            vscode.postMessage({ command: 'searchUsers', query });
                        }
                    }

                    function followUser(targetId) {
                        vscode.postMessage({ command: 'followUser', targetId });
                    }

                    function unfollowUser(targetId) {
                        vscode.postMessage({ command: 'unfollowUser', targetId });
                    }

                    // Listen for dynamic search results
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'searchResults') {
                            const resultsContainer = document.getElementById('searchResults');
                            if (message.results.length === 0) {
                                resultsContainer.innerHTML = '<div style="font-weight: 700; padding: 8px;">No users found.</div>';
                                return;
                            }
                            
                            resultsContainer.innerHTML = message.results.map(user => \`
                                <div style="border: 2px solid #000; padding: 8px; margin-bottom: 8px; background: #fff; display: flex; justify-content: space-between; align-items: center;">
                                    <div>
                                        <div style="font-weight: 900;">\${user.name}</div>
                                        <div style="font-size: 11px; font-weight: 700; color: #555;">🔥 \${user.daily_streak}d streak</div>
                                    </div>
                                    <button class="btn btn-blue" style="padding: 4px 8px; font-size: 11px;" onclick="followUser('\${user.github_id}')">Add</button>
                                </div>
                            \`).join('');
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    public dispose() {
        this._disposed = true;
        DashboardPanel.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
