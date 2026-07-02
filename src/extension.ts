import * as vscode from 'vscode';
import { DatabaseService } from './database';
import { AuthenticationManager } from './auth';
import { ActivityTracker } from './tracker';
import { DashboardPanel } from './dashboard';

let broadcastInterval: NodeJS.Timeout | null = null;
let dbService: DatabaseService;
let authManager: AuthenticationManager;
let tracker: ActivityTracker;

export async function activate(context: vscode.ExtensionContext) {
    console.log('PiperCode Tracker is now active!');

    // 1. Initialize Database Service
    dbService = new DatabaseService();
    const dbOk = await dbService.initialize();
    if (!dbOk) {
        console.warn('PiperCode: Database connection could not be established. Falling back to local state.');
    }

    // 2. Initialize Authentication Manager
    authManager = new AuthenticationManager(context);
    await authManager.initialize();

    // 3. Initialize Activity Tracker
    tracker = new ActivityTracker(
        context,
        dbService,
        () => authManager.getGitHubId()
    );
    tracker.startTracking();

    // 4. Register commands
    
    // Command: Open Dashboard
    let openDashboardCommand = vscode.commands.registerCommand('pipercode.openDashboard', () => {
        DashboardPanel.createOrShow(
            context.extensionUri,
            context,
            dbService,
            authManager,
            tracker
        );
    });

    // Command: Show Stats modal
    let showStatsCommand = vscode.commands.registerCommand('pipercode.showStats', async () => {
        const stats = tracker.getActiveStats();
        const isGuest = authManager.isGuest();
        let streak = 0;

        if (!isGuest && dbService.isConnected()) {
            const githubId = authManager.getGitHubId();
            if (githubId) {
                const user = await dbService.getUser(githubId);
                if (user) streak = user.daily_streak;
            }
        } else {
            streak = context.globalState.get<number>('pipercode.guest.streak') || 0;
        }

        const formatTimeHMS = (totalSeconds: number) => {
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        };

        const timeDisplay = formatTimeHMS(stats.todaySeconds);
        const modeText = isGuest ? 'Guest Mode' : 'GitHub Synced';

        vscode.window.showInformationMessage(
            `📊 PiperCode Coding Stats\n\n⏱️ Coded Today: ${timeDisplay}\n🔥 Daily Streak: ${streak} days\n💻 Current Language: ${stats.currentLanguage}\n📂 Project: ${stats.currentProject}\n🛡️ Mode: ${modeText}`,
            { modal: true }
        );
    });

    // Command: Show Today (Terminal layout)
    let showTodayCommand = vscode.commands.registerCommand('pipercode.showToday', async () => {
        const terminal = vscode.window.createTerminal('PiperCode Stats');
        terminal.show();

        const stats = tracker.getActiveStats();
        const isGuest = authManager.isGuest();
        let streak = 0;

        if (!isGuest && dbService.isConnected()) {
            const githubId = authManager.getGitHubId();
            if (githubId) {
                const user = await dbService.getUser(githubId);
                if (user) streak = user.daily_streak;
            }
        } else {
            streak = context.globalState.get<number>('pipercode.guest.streak') || 0;
        }

        const minutes = Math.floor(stats.todaySeconds / 60);
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        const timeDisplay = hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
        const modeLabel = isGuest ? 'GUEST MODE' : 'SYNCED';

        terminal.sendText(`echo "╭──────────────────────────────────────╮"`);
        terminal.sendText(`echo "│          PIPERCODE STATS             │"`);
        terminal.sendText(`echo "├──────────────────────────────────────┤"`);
        terminal.sendText(`echo "│ 📊 Today: ${timeDisplay.padEnd(26)} │"`);
        terminal.sendText(`echo "│ 🔥 Streak: ${`${streak} days`.padEnd(25)} │"`);
        terminal.sendText(`echo "│ 💻 Language: ${stats.currentLanguage.substring(0, 18).padEnd(23)} │"`);
        terminal.sendText(`echo "│ 🛡️ Mode: ${modeLabel.padEnd(28)} │"`);
        terminal.sendText(`echo "╰──────────────────────────────────────╯"`);
    });

    // 5. Discord-style Status Broadcast Loop (Every 60 seconds)
    broadcastInterval = setInterval(async () => {
        if (tracker.getActiveStats().isIdle) return; // Don't broadcast status changes if idle

        const githubId = authManager.getGitHubId();
        if (githubId && dbService.isConnected()) {
            const status = context.globalState.get<string>('pipercode.userStatus') || 'Coding...';
            const language = tracker.getLanguage();
            await dbService.updateStatus(githubId, status, language);
        }
    }, 60000);

    // Push disposables
    context.subscriptions.push(tracker);
    context.subscriptions.push(openDashboardCommand);
    context.subscriptions.push(showStatsCommand);
    context.subscriptions.push(showTodayCommand);
}

export function deactivate() {
    console.log('PiperCode Tracker is now deactivated!');
    if (broadcastInterval) {
        clearInterval(broadcastInterval);
    }
}
