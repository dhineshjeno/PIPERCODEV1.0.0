import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseService, UserStats } from './database';

// Language IDs that should NOT be tracked
const IGNORED_LANGUAGES = new Set([
    'plaintext', 'log', 'scminput', 'search-result', 'output'
]);

export class ActivityTracker implements vscode.Disposable {
    private isTracking = false;
    private isIdle = false;
    private hasEverCoded = false; // True after first real keystroke in a code file
    private lastKeystrokeTime: number = Date.now();
    private activeSecondsToday = 0;
    private activeSecondsThisMonth = 0;
    private currentLanguage = 'Waiting...';
    private currentProject = 'Unknown Project';

    private statusBarItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];
    private syncTimer: NodeJS.Timeout | null = null;
    private idleCheckTimer: NodeJS.Timeout | null = null;

    // Callbacks to notify Webview of data changes
    private onStatsUpdatedCallback: (() => void) | null = null;

    constructor(
        private context: vscode.ExtensionContext,
        private dbService: DatabaseService,
        private getGitHubId: () => string | null
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.setupStatusBar();
        this.loadInitialStats();
    }

    public registerOnStatsUpdated(callback: () => void) {
        this.onStatsUpdatedCallback = callback;
    }

    private setupStatusBar() {
        this.statusBarItem.text = "$(watch) PiperCode";
        this.statusBarItem.tooltip = "PiperCode Coding Tracker";
        this.statusBarItem.command = 'pipercode.openDashboard';
        this.statusBarItem.show();
    }

    /**
     * Loads the initial time metrics from either DB (if authenticated) or local state (if guest).
     */
    private async loadInitialStats() {
        const githubId = this.getGitHubId();
        if (githubId && this.dbService.isConnected()) {
            try {
                const user = await this.dbService.getUser(githubId);
                if (user) {
                    this.activeSecondsToday = user.total_seconds_today;
                    this.activeSecondsThisMonth = user.total_seconds_this_month;
                }
            } catch (error) {
                console.error('PiperCode: Failed to load initial stats from DB:', error);
                this.loadLocalStats();
            }
        } else {
            this.loadLocalStats();
        }
        this.updateStatusBar();
    }

    private loadLocalStats() {
        const todayStr = this.getLocalDateString();
        const lastActive = this.context.globalState.get<string>('pipercode.guest.lastActiveDate');

        if (lastActive !== todayStr) {
            // Check if month rolls over
            const todayMonth = this.getLocalMonthString();
            const lastMonth = lastActive ? lastActive.substring(0, 7) : '';

            if (lastMonth && lastMonth !== todayMonth) {
                // Archive previous month locally
                const archives = this.context.globalState.get<any[]>('pipercode.guest.archives') || [];
                const monthSeconds = this.context.globalState.get<number>('pipercode.guest.monthTime') || 0;
                const monthLanguages = this.context.globalState.get<Record<string, number>>('pipercode.guest.languages') || {};

                archives.push({
                    month_identifier: lastMonth,
                    total_seconds: monthSeconds,
                    top_languages: monthLanguages
                });
                this.context.globalState.update('pipercode.guest.archives', archives);

                // Reset monthly metrics
                this.context.globalState.update('pipercode.guest.monthTime', 0);
                this.context.globalState.update('pipercode.guest.languages', {});
            }

            this.context.globalState.update('pipercode.guest.todayTime', 0);
        }

        this.activeSecondsToday = this.context.globalState.get<number>('pipercode.guest.todayTime') || 0;
        this.activeSecondsThisMonth = this.context.globalState.get<number>('pipercode.guest.monthTime') || 0;
    }

    /**
     * Check if a document is a trackable code file (not plaintext, log, etc.)
     */
    private isTrackableDocument(document: vscode.TextDocument): boolean {
        if (!document) return false;
        const langId = document.languageId.toLowerCase();
        if (IGNORED_LANGUAGES.has(langId)) return false;
        // Also skip VS Code internal scheme documents (like output panels, git diffs, etc.)
        if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return false;
        return true;
    }

    public startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;
        this.lastKeystrokeTime = Date.now();
        this.isIdle = false;
        this.hasEverCoded = false;

        // Monitor active editor changes
        const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document && this.isTrackableDocument(editor.document)) {
                this.updateLanguageAndProject(editor.document);
                this.handleKeystrokeActivity();
            }
        });

        // Monitor document edits
        const docChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
            // Skip non-trackable documents (plaintext, log, output panels, etc.)
            if (!this.isTrackableDocument(event.document)) return;

            // Check length of change (anti-cheat verification)
            let totalAddedLength = 0;
            for (const change of event.contentChanges) {
                totalAddedLength += change.text.length;
            }

            if (totalAddedLength > 1000) {
                console.log(`PiperCode: Anti-cheat flagged. Large change of ${totalAddedLength} chars ignored.`);
                return;
            }

            if (totalAddedLength > 0) {
                this.updateLanguageAndProject(event.document);
                this.handleKeystrokeActivity();
            }
        });

        // Monitor file saves
        const saveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
            if (!this.isTrackableDocument(document)) return;
            this.updateLanguageAndProject(document);
            this.handleKeystrokeActivity();
        });

        this.disposables.push(activeEditorDisposable, docChangeDisposable, saveDisposable);

        // Initialize values from active editor if present
        if (vscode.window.activeTextEditor && this.isTrackableDocument(vscode.window.activeTextEditor.document)) {
            this.updateLanguageAndProject(vscode.window.activeTextEditor.document);
        }

        // Start Periodic Heartbeat Sync Timer (every 10 seconds)
        this.syncTimer = setInterval(() => {
            this.syncTick();
        }, 10000);

        // Start Rolling Inactivity Checking Timer (every 5 seconds)
        this.idleCheckTimer = setInterval(() => {
            this.checkInactivity();
        }, 5000);

        console.log('PiperCode: Tracking engine active.');
        this.updateStatusBar();
    }

    /**
     * Evaluates current active file's language and project scope
     */
    private updateLanguageAndProject(document: vscode.TextDocument) {
        if (!document) return;
        this.currentLanguage = this.getCleanLanguage(document.languageId);
        this.currentProject = this.getProjectName();
    }

    /**
     * Resets idle state and updates lastKeystrokeTime on valid typing activity.
     */
    private handleKeystrokeActivity() {
        this.lastKeystrokeTime = Date.now();
        this.hasEverCoded = true;
        if (this.isIdle) {
            this.isIdle = false;
            console.log('PiperCode: Keystroke detected, resuming tracking.');
            this.updateStatusBar();
        }
    }

    /**
     * Running task checks if the user has been inactive for >= 120 seconds.
     * Only triggers idle if user has actually coded at least once this session.
     */
    private checkInactivity() {
        if (this.isIdle) return;
        if (!this.hasEverCoded) return; // Don't go idle if user hasn't typed in any code file yet

        const timeSinceLastKeystroke = Date.now() - this.lastKeystrokeTime;

        if (timeSinceLastKeystroke >= 120000) { // 120 seconds (2 minutes)
            this.isIdle = true;
            console.log('PiperCode: Idle threshold reached (120s). Pausing tracker.');
            this.updateStatusBar();
            if (this.onStatsUpdatedCallback) {
                this.onStatsUpdatedCallback();
            }
        }
    }

    /**
     * Sync time logs. Fired every 10 seconds.
     */
    private async syncTick() {
        if (this.isIdle || !this.isTracking || !this.hasEverCoded) return;

        // Add 10 seconds of active coding
        this.activeSecondsToday += 10;
        this.activeSecondsThisMonth += 10;

        const githubId = this.getGitHubId();
        const thresholdMinutes = vscode.workspace.getConfiguration('pipercode').get<number>('streakDailyThresholdMinutes') || 30;

        if (githubId && this.dbService.isConnected()) {
            // Authenticated Mode: Sync with PostgreSQL
            try {
                const updatedUser = await this.dbService.syncActivity(
                    githubId,
                    10,
                    this.currentLanguage,
                    thresholdMinutes
                );
                if (updatedUser) {
                    this.activeSecondsToday = updatedUser.total_seconds_today;
                    this.activeSecondsThisMonth = updatedUser.total_seconds_this_month;
                }
            } catch (error) {
                console.error('PiperCode: Failed to sync activity with PostgreSQL:', error);
            }
        } else {
            // Guest Mode: Sync locally in globalState
            this.syncGuestActivity(10, thresholdMinutes);
        }

        this.updateStatusBar();

        if (this.onStatsUpdatedCallback) {
            this.onStatsUpdatedCallback();
        }
    }

    /**
     * Local storage updates for Guests
     */
    private syncGuestActivity(secondsToAdd: number, thresholdMinutes: number) {
        const todayStr = this.getLocalDateString();
        const currentMonthStr = this.getLocalMonthString();
        
        let lastActive = this.context.globalState.get<string>('pipercode.guest.lastActiveDate');
        let todayTime = this.context.globalState.get<number>('pipercode.guest.todayTime') || 0;
        let monthTime = this.context.globalState.get<number>('pipercode.guest.monthTime') || 0;
        let languageStats = this.context.globalState.get<Record<string, number>>('pipercode.guest.languages') || {};
        let dailyStreak = this.context.globalState.get<number>('pipercode.guest.streak') || 0;
        let lastStreakIncrement = this.context.globalState.get<string | null>('pipercode.guest.lastStreakIncrementDate') || null;

        // Monthly rollover
        if (lastActive && lastActive.substring(0, 7) !== currentMonthStr) {
            const archives = this.context.globalState.get<any[]>('pipercode.guest.archives') || [];
            archives.push({
                month_identifier: lastActive.substring(0, 7),
                total_seconds: monthTime,
                top_languages: languageStats
            });
            this.context.globalState.update('pipercode.guest.archives', archives);
            
            monthTime = 0;
            languageStats = {};
            todayTime = 0;
        }

        // Daily rollover
        if (lastActive !== todayStr) {
            todayTime = 0;
        }

        // Increment seconds
        todayTime += secondsToAdd;
        monthTime += secondsToAdd;
        languageStats[this.currentLanguage] = (languageStats[this.currentLanguage] || 0) + secondsToAdd;

        // Streak check
        const thresholdSeconds = thresholdMinutes * 60;
        if (todayTime >= thresholdSeconds) {
            if (lastStreakIncrement !== todayStr) {
                const yesterdayStr = this.getYesterdayDateString();
                if (lastStreakIncrement === yesterdayStr) {
                    dailyStreak += 1;
                } else {
                    dailyStreak = 1;
                }
                lastStreakIncrement = todayStr;
                this.context.globalState.update('pipercode.guest.lastStreakIncrementDate', lastStreakIncrement);
                this.context.globalState.update('pipercode.guest.streak', dailyStreak);
            }
        }

        // Save back
        this.context.globalState.update('pipercode.guest.lastActiveDate', todayStr);
        this.context.globalState.update('pipercode.guest.todayTime', todayTime);
        this.context.globalState.update('pipercode.guest.monthTime', monthTime);
        this.context.globalState.update('pipercode.guest.languages', languageStats);

        this.activeSecondsToday = todayTime;
        this.activeSecondsThisMonth = monthTime;
    }

    private updateStatusBar() {
        const minutes = Math.floor(this.activeSecondsToday / 60);
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;

        const timeString = hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;

        if (!this.hasEverCoded) {
            // Fresh session, no code file opened yet
            this.statusBarItem.text = `$(watch) PiperCode: Ready`;
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = `PiperCode: Open a code file and start typing to begin tracking!`;
        } else if (this.isIdle) {
            this.statusBarItem.text = `$(history) PiperCode: Idle`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.tooltip = `PiperCode: Paused due to inactivity. Type in a code file to resume.\n(Coded ${timeString} today)`;
        } else {
            this.statusBarItem.text = `$(watch) PiperCode: ${timeString}`;
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = `PiperCode: Active | Coding in ${this.currentLanguage} | Project: ${this.currentProject}`;
        }
    }

    public getLanguage(): string {
        return this.currentLanguage;
    }

    public getProject(): string {
        return this.currentProject;
    }

    public getActiveStats() {
        return {
            todaySeconds: this.activeSecondsToday,
            monthSeconds: this.activeSecondsThisMonth,
            isIdle: this.isIdle,
            hasEverCoded: this.hasEverCoded,
            currentLanguage: this.currentLanguage,
            currentProject: this.currentProject
        };
    }

    public forceReloadStats() {
        this.loadInitialStats();
    }

    private getCleanLanguage(languageId: string): string {
        if (!languageId) return 'Unknown';
        
        const languageMap: Record<string, string> = {
            'javascript': 'JavaScript',
            'typescript': 'TypeScript',
            'javascriptreact': 'JSX',
            'typescriptreact': 'TSX',
            'python': 'Python',
            'java': 'Java',
            'cpp': 'C++',
            'c': 'C',
            'csharp': 'C#',
            'php': 'PHP',
            'ruby': 'Ruby',
            'go': 'Go',
            'rust': 'Rust',
            'html': 'HTML',
            'css': 'CSS',
            'json': 'JSON',
            'markdown': 'Markdown',
            'shellscript': 'Shell',
            'yaml': 'YAML',
            'xml': 'XML',
            'sql': 'SQL',
            'swift': 'Swift',
            'kotlin': 'Kotlin',
            'dart': 'Dart',
            'lua': 'Lua',
            'perl': 'Perl',
            'r': 'R',
            'scala': 'Scala',
            'objective-c': 'Objective-C',
            'objective-cpp': 'Objective-C++',
            'coffeescript': 'CoffeeScript',
            'fsharp': 'F#',
            'haskell': 'Haskell',
            'elixir': 'Elixir',
            'erlang': 'Erlang',
            'clojure': 'Clojure',
            'powershell': 'PowerShell',
            'bat': 'Batch',
            'dockerfile': 'Docker',
            'makefile': 'Makefile',
            'toml': 'TOML',
            'ini': 'INI',
            'scss': 'SCSS',
            'sass': 'Sass',
            'less': 'LESS',
            'vue': 'Vue',
            'svelte': 'Svelte',
            'graphql': 'GraphQL',
            'prisma': 'Prisma',
            'proto3': 'Protobuf',
            'jade': 'Pug',
            'handlebars': 'Handlebars',
            'razor': 'Razor',
            'latex': 'LaTeX',
            'bibtex': 'BibTeX',
            'vb': 'Visual Basic',
            'groovy': 'Groovy',
            'julia': 'Julia',
            'zig': 'Zig',
            'nim': 'Nim',
            'v': 'V',
            'solidity': 'Solidity',
            'cuda-cpp': 'CUDA C++',
            'hlsl': 'HLSL',
            'glsl': 'GLSL',
            'wgsl': 'WGSL',
            'assembly': 'Assembly',
            'asm': 'Assembly'
        };

        const key = languageId.toLowerCase();
        if (languageMap[key]) {
            return languageMap[key];
        }
        
        // Auto-capitalize other unknown languages
        return languageId.charAt(0).toUpperCase() + languageId.slice(1);
    }

    private getProjectName(): string {
        try {
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                return path.basename(vscode.workspace.workspaceFolders[0].uri.fsPath);
            }
        } catch (error) {
            console.log('PiperCode: No workspace folder found');
        }
        return 'Unknown Project';
    }

    private getLocalDateString(d: Date = new Date()): string {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    private getLocalMonthString(d: Date = new Date()): string {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        return `${year}-${month}`;
    }

    private getYesterdayDateString(): string {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return this.getLocalDateString(d);
    }

    public dispose() {
        this.statusBarItem.dispose();
        if (this.syncTimer) clearInterval(this.syncTimer);
        if (this.idleCheckTimer) clearInterval(this.idleCheckTimer);
        this.disposables.forEach((d) => d.dispose());
    }
}
