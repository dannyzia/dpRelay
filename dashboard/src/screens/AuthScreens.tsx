import { useState, type FormEvent } from "react";
import { ApiError, login, register } from "../api.js";
import { notifyAuthChanged } from "../auth.js";

/** Maps server error codes to field-level hints the user can act on. */
function errorHint(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "invalid_credentials":
        return "Email or password is incorrect.";
      case "email_taken":
        return "That email is already registered — try signing in.";
      case "invalid_email":
        return "Enter a valid email address.";
      case "invalid_password":
        return "Password must be at least 8 characters.";
      case "network_error":
        return "Cannot reach the API right now — try again shortly.";
      default:
        return err.message;
    }
  }
  return "Something went wrong — try again.";
}

function Field(props: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-300">{props.label}</span>
      <input
        type={props.type}
        value={props.value}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
        required
      />
    </label>
  );
}

function SubmitButton(props: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <button
      type="submit"
      disabled={props.busy}
      className="w-full rounded-lg bg-sky-600 px-4 py-2.5 font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {props.busy ? props.busyLabel : props.label}
    </button>
  );
}

function ErrorBox(props: { message: string }) {
  return (
    <div role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
      {props.message}
    </div>
  );
}

export function LoginScreen(props: { onGoRegister: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      notifyAuthChanged();
    } catch (err) {
      setError(errorHint(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-xl">
      <h1 className="text-xl font-semibold text-slate-100">Sign in</h1>
      <p className="text-sm text-slate-400">dP Relay v5 dashboard</p>
      {error !== null && <ErrorBox message={error} />}
      <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="you@example.com" />
      <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <SubmitButton busy={busy} label="Sign in" busyLabel="Signing in…" />
      <p className="text-sm text-slate-400">
        No account?{" "}
        <button type="button" onClick={props.onGoRegister} className="font-medium text-sky-400 hover:text-sky-300">
          Register
        </button>
      </p>
    </form>
  );
}

export function RegisterScreen(props: { onGoLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email.trim(), password);
      setDone(true);
    } catch (err) {
      setError(errorHint(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center shadow-xl">
        <h1 className="text-xl font-semibold text-slate-100">Account created</h1>
        <p className="text-sm text-slate-400">Sign in to continue.</p>
        <button
          type="button"
          onClick={props.onGoLogin}
          className="w-full rounded-lg bg-sky-600 px-4 py-2.5 font-medium text-white hover:bg-sky-500"
        >
          Go to sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-xl">
      <h1 className="text-xl font-semibold text-slate-100">Create account</h1>
      <p className="text-sm text-slate-400">Register for the dP Relay v5 dashboard</p>
      {error !== null && <ErrorBox message={error} />}
      <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="you@example.com" />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <SubmitButton busy={busy} label="Create account" busyLabel="Creating…" />
      <p className="text-sm text-slate-400">
        Already registered?{" "}
        <button type="button" onClick={props.onGoLogin} className="font-medium text-sky-400 hover:text-sky-300">
          Sign in
        </button>
      </p>
    </form>
  );
}
