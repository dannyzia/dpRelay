import { useEffect, useState } from "react";
import { getConnectedApp, setAppDisconnectedHandler, setUnauthorizedHandler } from "./api.js";
import { isAuthenticated, signOut, subscribe } from "./auth.js";
import { LoginScreen, RegisterScreen } from "./screens/AuthScreens.js";
import { CampaignsScreen } from "./screens/CampaignsScreen.js";
import { ConnectAppScreen } from "./screens/ConnectAppScreen.js";
import { CreditsScreen } from "./screens/CreditsScreen.js";

type Screen = "campaigns" | "credits" | "authLogin" | "authRegister" | "connectApp";

/**
 * App shell over two credential planes:
 * 1. User session (JWT): login/register; a 401 from an authed user-plane call
 *    clears the session and lands on login.
 * 2. Connected app (X-App-Id/X-App-Secret): campaigns/credits are app-scoped
 *    server-side (requireApp), so after sign-in the operator connects the app
 *    whose credentials they manage; a 401 from an app-plane call drops the
 *    connection back to the connect screen without touching the user session.
 */
export function App() {
  const [authed, setAuthed] = useState(isAuthenticated());
  const [appConnected, setAppConnected] = useState(getConnectedApp() !== null);
  const [screen, setScreen] = useState<Screen>(() => (isAuthenticated() ? "campaigns" : "authLogin"));

  useEffect(() => {
    const unsub = subscribe(() => {
      const nowAuthed = isAuthenticated();
      setAuthed(nowAuthed);
      setAppConnected(nowAuthed && getConnectedApp() !== null);
      setScreen((current) => {
        if (nowAuthed) return current === "authLogin" || current === "authRegister" ? "campaigns" : current;
        return "authLogin";
      });
    });
    setUnauthorizedHandler(() => {
      setAuthed(false);
      setAppConnected(false);
      setScreen("authLogin");
    });
    setAppDisconnectedHandler(() => {
      setAppConnected(false);
    });
    return () => {
      unsub();
      setUnauthorizedHandler(null);
      setAppDisconnectedHandler(null);
    };
  }, []);

  function onConnected(): void {
    setAppConnected(true);
    setScreen("campaigns");
  }

  if (!authed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
        {screen === "authRegister" ? (
          <RegisterScreen onGoLogin={() => setScreen("authLogin")} />
        ) : (
          <LoginScreen onGoRegister={() => setScreen("authRegister")} />
        )}
      </main>
    );
  }

  if (!appConnected) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
        <div className="w-full max-w-sm space-y-4">
          <ConnectAppScreen onConnected={onConnected} />
          <button
            onClick={() => {
              signOut();
            }}
            className="w-full text-center text-sm text-slate-500 hover:text-slate-300"
          >
            Sign out instead
          </button>
        </div>
      </main>
    );
  }

  const navItems: Array<{ id: Screen; label: string }> = [
    { id: "campaigns", label: "Campaigns" },
    { id: "credits", label: "Credits" },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="font-semibold tracking-tight">dP Relay</span>
            <nav className="flex gap-1">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setScreen(item.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    screen === item.id ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-xs text-slate-500 sm:inline">{getConnectedApp()?.appId}</span>
            <button
              onClick={() => {
                signOut();
              }}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500 hover:text-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {screen === "credits" ? <CreditsScreen /> : <CampaignsScreen />}
      </main>
    </div>
  );
}
