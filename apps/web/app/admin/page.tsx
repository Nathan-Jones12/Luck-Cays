"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { sendEmailVerification, signInWithEmailAndPassword, signOut, type User } from "@firebase/auth";
import { ArrowLeft, LogOut, Plus, ShieldCheck } from "lucide-react";
import { getFirebaseAuth, isFirebaseClientConfigured } from "@/app/lib/client/firebase-auth";

type Admin = { firebaseUid: string; email: string; role: "SUPER_ADMIN" | "CONTENT_ADMIN" };
type Game = {
  id: string;
  slug: string;
  name: string;
  category: string;
  studio: string;
  art: string;
  mark: string;
  description: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  createdAt: string;
};

const categories = ["Slots", "Table", "Instant"] as const;
const artThemes = ["coral", "lagoon", "mango", "night", "palm", "tide"] as const;

export default function AdminPage() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState<(typeof categories)[number]>("Slots");
  const [studio, setStudio] = useState("");
  const [artTheme, setArtTheme] = useState<(typeof artThemes)[number]>("lagoon");
  const [mark, setMark] = useState("*");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"DRAFT" | "PUBLISHED">("DRAFT");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  async function loadGames() {
    const response = await fetch("/api/admin/games", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the saved catalog");
    const result = await response.json() as { games: Game[] };
    setGames(result.games);
  }

  useEffect(() => {
    let active = true;
    fetch("/api/admin/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ admin: Admin }>;
      })
      .then(async (result) => {
        if (!active || !result) return;
        setAdmin(result.admin);
        try {
          await loadGames();
        } catch {
          if (active) setMessage("The saved catalog is unavailable. Apply the database migration first.");
        }
      })
      .catch(() => undefined)
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const credential = await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
      if (!credential.user.emailVerified) {
        try {
          await sendEmailVerification(credential.user);
        } catch {
          await signOut(getFirebaseAuth());
          throw new Error("This Firebase account is not email-verified, and Firebase could not send a verification email. Check the Authentication email templates and try again.");
        }
        await signOut(getFirebaseAuth());
        throw new Error("Verification email sent. Open the link in your inbox, then return here and sign in again.");
      }
      setFirebaseUser(credential.user);
      setPassword("");
      setMessage("Enter the current code from your authenticator app.");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("Verification email sent") || message.startsWith("This Firebase account is not email-verified")) {
        setMessage(message);
      } else if (code === "auth/invalid-credential" || code === "auth/invalid-login-credentials" || code === "auth/user-not-found" || code === "auth/wrong-password") {
        setMessage("Firebase rejected this email/password. In Firebase Console, confirm this exact email exists under Authentication → Users in the configured project and that its sign-in provider is Email/Password. If the account uses Google or another provider, its provider password will not work here; use that provider or link/set an email/password credential for the same Firebase user. (" + (code || "credential rejected") + ")");
      } else if (code === "auth/operation-not-allowed") {
        setMessage("Email/Password sign-in is disabled for this Firebase project. Enable it under Authentication → Sign-in method. (auth/operation-not-allowed)");
      } else if (code === "auth/invalid-api-key" || code === "auth/app-not-authorized" || code === "auth/configuration-not-found") {
        setMessage("Firebase rejected this web app configuration. Confirm the Web app settings in .env.local belong to the same Firebase project. (" + code + ")");
      } else if (code === "auth/user-disabled") {
        setMessage("This Firebase user is disabled. Re-enable the account under Authentication → Users. (auth/user-disabled)");
      } else if (code === "auth/too-many-requests") {
        setMessage("Too many sign-in attempts. Wait a while and try again.");
      } else if (code === "auth/network-request-failed") {
        setMessage("Could not reach Firebase. Check your connection and project configuration.");
      } else {
        setMessage("Sign-in failed. Check the Firebase configuration and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firebaseUser) return;
    setBusy(true);
    setMessage("");
    try {
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, totpCode }),
      });
      const result = await response.json() as { admin?: Admin; error?: string };
      if (!response.ok || !result.admin) throw new Error(result.error || "Admin sign-in failed");
      setAdmin(result.admin);
      setTotpCode("");
      await loadGames();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Admin sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateGame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, category, studio, artTheme, mark, description, status }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save the game");
      await loadGames();
      setName("");
      setSlug("");
      setStudio("");
      setMark("*");
      setDescription("");
      setStatus("DRAFT");
      setMessage("Game saved to the Luck-Cays catalog. Real-money play remains disabled.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the game");
    } finally {
      setBusy(false);
    }
  }

  function updateGameName(value: string) {
    setName(value);
    setSlug(value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80));
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/session", { method: "DELETE" });
      if (!response.ok) throw new Error("The server could not revoke the admin session. Try again before leaving this page.");
      setAdmin(null);
      setFirebaseUser(null);
      setGames([]);
      try {
        if (firebaseUser) await signOut(getFirebaseAuth());
        setMessage("Signed out securely.");
      } catch {
        setMessage("The admin session was revoked. Firebase could not clear its local sign-in; close this tab and review Firebase connectivity.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign out securely. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const firebaseConfigured = isFirebaseClientConfigured();

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <Link href="/" className="admin-brand"><span className="admin-brand-mark">LC</span><span>Luck-Cays <small>ADMIN</small></span></Link>
        <Link href="/" className="admin-back"><ArrowLeft size={15} /> Back to game room</Link>
      </header>

      <div className="admin-content">
        <div className="admin-heading">
          <div><div className="admin-eyebrow"><ShieldCheck size={15} /> SECURE CONTENT MANAGEMENT</div><h1>Game catalog</h1></div>
          {admin && <button className="admin-logout" type="button" disabled={busy} onClick={handleSignOut}><LogOut size={15} /> Sign out</button>}
        </div>

        {!firebaseConfigured && <div className="admin-alert" role="alert">Firebase sign-in is not configured. Add the Luck-Cays Firebase web settings to <code>.env.local</code>.</div>}
        {message && <div className="admin-message" role="status">{message}</div>}

        {checkingSession ? <div className="admin-panel admin-loading">Checking admin session…</div> : !admin ? (
          <section className="admin-panel admin-auth-panel" aria-labelledby="admin-auth-title">
            {!firebaseUser ? (
              <form className="admin-form admin-signin-form" onSubmit={handleSignIn}>
                <div><span className="admin-eyebrow admin-eyebrow-dark">ADMIN ACCESS</span><h2 id="admin-auth-title">Sign in to continue</h2><p>Use a verified Firebase account that has been provisioned for Luck-Cays.</p></div>
                <label>Email<input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
                <label>Password<input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                <button className="admin-primary" type="submit" disabled={busy || !firebaseConfigured}>{busy ? "Signing in…" : "Continue"}</button>
              </form>
            ) : (
              <form className="admin-form admin-signin-form" onSubmit={handleMfa}>
                <div><span className="admin-eyebrow admin-eyebrow-dark">SECOND FACTOR</span><h2 id="admin-auth-title">Verify it’s you</h2><p>Enter the current six-digit code from your authenticator app.</p></div>
                <label>Authenticator code<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
                <button className="admin-primary" type="submit" disabled={busy || totpCode.length !== 6}>{busy ? "Verifying…" : "Verify and open catalog"}</button>
                <button className="admin-secondary" type="button" disabled={busy} onClick={async () => { await signOut(getFirebaseAuth()); setFirebaseUser(null); setTotpCode(""); setMessage(""); }}>Use another account</button>
              </form>
            )}
          </section>
        ) : (
          <>
            <div className="admin-userbar"><span>Signed in as <strong>{admin.email}</strong></span><span className="admin-role">{admin.role.replace("_", " ")}</span></div>
            <section className="admin-panel" aria-labelledby="add-game-title">
              <div className="admin-panel-heading"><div><span className="admin-eyebrow admin-eyebrow-dark">CATALOG ENTRY</span><h2 id="add-game-title">Add a game</h2></div><span className="admin-demo-badge">DEMO CATALOG ONLY</span></div>
              <form className="admin-game-form" onSubmit={handleCreateGame}>
                <label>Game name<input required maxLength={120} value={name} onChange={(event) => updateGameName(event.target.value)} /></label>
                <label>URL slug<input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} /></label>
                <label>Category<select value={category} onChange={(event) => setCategory(event.target.value as (typeof categories)[number])}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
                <label>Studio<input required maxLength={100} value={studio} onChange={(event) => setStudio(event.target.value)} /></label>
                <label>Artwork theme<select value={artTheme} onChange={(event) => setArtTheme(event.target.value as (typeof artThemes)[number])}>{artThemes.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}</select></label>
                <label>Card mark<input required maxLength={16} value={mark} onChange={(event) => setMark(event.target.value)} /></label>
                <label className="admin-field-wide">Description<textarea maxLength={280} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
                <label>Visibility<select value={status} onChange={(event) => setStatus(event.target.value as "DRAFT" | "PUBLISHED")}><option value="DRAFT">Draft</option><option value="PUBLISHED">Publish to lobby</option></select></label>
                <div className="admin-form-note"><ShieldCheck size={15} /> New games are demo-catalog entries only. Cash wagering is not supported.</div>
                <div className="admin-form-actions"><button className="admin-primary" type="submit" disabled={busy || !slug || !name || !studio}><Plus size={16} /> {busy ? "Saving…" : "Save game"}</button></div>
              </form>
            </section>

            <section className="admin-panel admin-list-panel" aria-labelledby="catalog-list-title">
              <div className="admin-panel-heading"><div><span className="admin-eyebrow admin-eyebrow-dark">SAVED IN MYSQL</span><h2 id="catalog-list-title">Catalog entries <span className="admin-count">{games.length}</span></h2></div></div>
              {games.length === 0 ? <p className="admin-empty">No catalog entries yet. Add the first demo game above.</p> : (
                <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Game</th><th>Category</th><th>Studio</th><th>Visibility</th></tr></thead><tbody>{games.map((game) => <tr key={game.id}><td><strong>{game.name}</strong><small>/{game.slug}</small></td><td>{game.category}</td><td>{game.studio}</td><td><span className={`status-tag status-${game.status.toLowerCase()}`}>{game.status}</span></td></tr>)}</tbody></table></div>
              )}
            </section>
          </>
        )}

        <footer className="admin-footer">Admin actions are authenticated, role-checked, and written to the audit log. Real-money features remain disabled.</footer>
      </div>
    </main>
  );
}
