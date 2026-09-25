import { useEffect, useState } from "react";
import {
  createMessageTemplate,
  deleteMessageTemplate,
  describeError,
  listMessageTemplates,
  updateMessageTemplate,
  type MessageTemplate,
} from "../api.js";

/**
 * Message-templates management (app plane). Bodies are storage-only here —
 * the campaign-create path enforces send-time charset/length rules; this
 * screen mirrors the server's storage cap (1024 chars).
 */
const BODY_MAX = 1024;

export function TemplatesScreen() {
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MessageTemplate | null>(null);
  const [editName, setEditName] = useState("");
  const [editBody, setEditBody] = useState("");

  async function reload(): Promise<void> {
    try {
      const res = await listMessageTemplates();
      setTemplates(res.templates);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function submit(): Promise<void> {
    if (name.trim().length === 0 || body.length === 0) {
      setError("A template needs a name and a body");
      return;
    }
    setBusy(true);
    try {
      await createMessageTemplate(name.trim(), body);
      setNotice("Template created");
      setName("");
      setBody("");
      setError(null);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(t: MessageTemplate): void {
    setEditing(t);
    setEditName(t.name);
    setEditBody(t.body);
  }

  async function saveEdit(): Promise<void> {
    if (editing === null) return;
    setBusy(true);
    try {
      const fields: { name?: string; body?: string } = {};
      if (editName.trim() !== editing.name) fields.name = editName.trim();
      if (editBody !== editing.body) fields.body = editBody;
      if (Object.keys(fields).length === 0) {
        setEditing(null);
        return;
      }
      await updateMessageTemplate(editing.templateId, fields);
      setNotice("Template updated");
      setEditing(null);
      setError(null);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function destroy(t: MessageTemplate): Promise<void> {
    if (!confirm(`Delete template "${t.name}"? Campaigns already created keep their message text.`)) return;
    setBusy(true);
    try {
      await deleteMessageTemplate(t.templateId);
      setNotice("Template deleted");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Message templates</h2>
        <p className="text-sm text-slate-400">Reusable bodies for campaigns (max {BODY_MAX} chars stored; send rules apply at campaign time).</p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-sm font-medium text-slate-200">New template</h3>
        <div className="mt-3 grid gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Template name"
            maxLength={100}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message body"
            rows={3}
            maxLength={BODY_MAX}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <p className="text-xs text-slate-500">{body.length}/{BODY_MAX}</p>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="w-fit rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Create template
          </button>
        </div>
      </div>

      {error !== null && <p className="rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {notice !== null && <p className="rounded-lg border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">{notice}</p>}

      {templates === null ? (
        <p className="text-sm text-slate-500">Loading templates…</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-slate-500">No templates yet — create one above.</p>
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li key={t.templateId} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              {editing?.templateId === t.templateId ? (
                <div className="grid gap-3">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={100}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
                  />
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={3}
                    maxLength={BODY_MAX}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => void saveEdit()} disabled={busy} className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50">
                      Save
                    </button>
                    <button onClick={() => setEditing(null)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{t.name}</p>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-slate-400">{t.body}</p>
                    <p className="mt-1 text-xs text-slate-500">updated {new Date(t.updatedAt * 1000).toLocaleString()}</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => startEdit(t)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 hover:text-sky-300">
                      Edit
                    </button>
                    <button onClick={() => void destroy(t)} disabled={busy} className="rounded-lg border border-rose-900 px-3 py-1.5 text-xs text-rose-300 hover:border-rose-500 disabled:opacity-50">
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
