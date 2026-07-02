import * as vscode from 'vscode';

export class AuthenticationManager {
    private session: vscode.AuthenticationSession | null = null;
    private authMode: 'authenticated' | 'guest' = 'guest';

    constructor(private context: vscode.ExtensionContext) {
        // Read stored auth preference
        const storedMode = this.context.globalState.get<'authenticated' | 'guest'>('pipercode.auth.mode');
        if (storedMode) {
            this.authMode = storedMode;
        } else {
            this.authMode = 'guest';
        }
    }

    /**
     * Initializes authentication and attempts to fetch an existing GitHub session.
     */
    public async initialize(): Promise<void> {
        if (this.authMode === 'authenticated') {
            try {
                // Try to get active session without prompting
                const existingSession = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
                if (existingSession) {
                    this.session = existingSession;
                } else {
                    // Session lost or expired, fall back to guest
                    this.authMode = 'guest';
                    this.context.globalState.update('pipercode.auth.mode', 'guest');
                }
            } catch (error) {
                console.error('PiperCode: Error checking GitHub session:', error);
                this.authMode = 'guest';
            }
        }
    }

    public isGuest(): boolean {
        return this.authMode === 'guest' || !this.session;
    }

    public getGitHubId(): string | null {
        return this.session ? this.session.account.id : null;
    }

    public getGitHubUsername(): string {
        return this.session ? this.session.account.label : 'Guest';
    }

    /**
     * Triggers VS Code's GitHub sign-in flow.
     */
    public async signIn(): Promise<boolean> {
        try {
            const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
            if (session) {
                this.session = session;
                this.authMode = 'authenticated';
                await this.context.globalState.update('pipercode.auth.mode', 'authenticated');
                vscode.window.showInformationMessage(`Successfully signed in to PiperCode as ${session.account.label}!`);
                return true;
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`PiperCode: Sign-in failed: ${error.message}`);
        }
        return false;
    }

    /**
     * Signs out, wiping local session reference and setting mode to guest.
     */
    public async signOut(): Promise<void> {
        this.session = null;
        this.authMode = 'guest';
        await this.context.globalState.update('pipercode.auth.mode', 'guest');
        vscode.window.showInformationMessage('Signed out from PiperCode. Switched to Guest Mode.');
    }
}
