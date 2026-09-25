import { useEffect, useState } from "react";
import {
  addGroupPhones,
  createContactGroup,
  deleteContactGroup,
  describeError,
  getContactGroup,
  listContactGroups,
  removeGroupPhones,
  renameContactGroup,
  type ContactGroup,
  type ContactGroupDetail,
} from "../api.js";

/**
 * Contact-groups management (app plane). Mirrors the server contract:
 * strict E.164 membership, dedup on add, 409 on duplicate group names,
 * delete cascades members (campaigns keep their materialized recipients).
 */
export function GroupsScreen() {
  const [groups, setGroups] = useState<ContactGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phones, setPhones] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<ContactGroupDetail | null>(null);

  async function reload(): Promise<void> {
    try {
      const body = await listContactGroups();
      setGroups(body.groups);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function submit(): Promise<void> {
    const parsed = phones
      .split(/[\s,;]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (name.trim().length === 0 || parsed.length === 0) {
      setError("A group needs a name and at least one phone number");
      return;
    }
    setBusy(true);
    try {
      const res = await createContactGroup(name.trim(), parsed);
      const extra = res.duplicateCount ? ` (${res.duplicateCount} duplicates removed)` : "";
      setNotice(`Group created with ${res.phoneCount} numbers${extra}`);
      setName("");
      setPhones("");
      setError(null);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function openGroup(id: string): Promise<void> {
    try {
      setOpen(await getContactGroup(id));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function addPhones(id: string): Promise<void> {
    const raw = prompt("Phone numbers to add (separated by spaces, commas, or newlines):");
    if (raw === null) return;
    const parsed = raw
      .split(/[\s,;]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parsed.length === 0) return;
    setBusy(true);
    try {
      const res = await addGroupPhones(id, parsed);
      const extra = res.duplicateCount ? ` (${res.duplicateCount} duplicates skipped)` : "";
      setNotice(`Added ${res.addedCount} numbers${extra}`);
      await openGroup(id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function removePhones(detail: ContactGroupDetail): Promise<void> {
    const raw = prompt(`Numbers to REMOVE from "${detail.name}" (separated by spaces, commas, or newlines):`);
    if (raw === null) return;
    const parsed = raw
      .split(/[\s,;]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parsed.length === 0) return;
    setBusy(true);
    try {
      const res = await removeGroupPhones(detail.groupId, parsed);
      setNotice(`Removed ${res.removedCount} numbers`);
      await openGroup(detail.groupId);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename(group: ContactGroup): Promise<void> {
    const next = prompt(`Rename "${group.name}" to:`, group.name);
    if (next === null || next.trim().length === 0 || next.trim() === group.name) return;
    setBusy(true);
    try {
      await renameContactGroup(group.groupId, next.trim());
      setNotice("Group renamed");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function destroy(group: ContactGroup): Promise<void> {
    if (!confirm(`Delete group "${group.name}" (${group.phoneCount} numbers)? Campaigns already created keep their recipients.`)) {
      return;
    }
    setBusy(true);
    try {
      await deleteContactGroup(group.groupId);
      setNotice("Group deleted");
      if (open?.groupId === group.groupId) setOpen(null);
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
        <h2 className="text-lg font-semibold">Contact groups</h2>
        <p className="text-sm text-slate-400">Recipient lists for bulk campaigns. Numbers must be E.164 (+8801XXXXXXXXX).</p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-sm font-medium text-slate-200">New group</h3>
        <div className="mt-3 grid gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
            maxLength={100}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <textarea
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            placeholder={"One or more numbers, any of: spaces, commas, newlines\n+8801XXXXXXXXX, +8801YYYYYYYY"}
            rows={4}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
          />
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="w-fit rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Create group
          </button>
        </div>
      </div>

      {error !== null && <p className="rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {notice !== null && <p className="rounded-lg border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">{notice}</p>}

      {groups === null ? (
        <p className="text-sm text-slate-500">Loading groups…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-slate-500">No groups yet — create one above.</p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li key={g.groupId} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{g.name}</p>
                  <p className="text-xs text-slate-500">
                    {g.phoneCount} numbers · created {new Date(g.createdAt * 1000).toLocaleString()}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => void openGroup(g.groupId)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 hover:text-sky-300">
                    View
                  </button>
                  <button onClick={() => void addPhones(g.groupId)} disabled={busy} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 hover:text-sky-300 disabled:opacity-50">
                    Add numbers
                  </button>
                  <button onClick={() => void rename(g)} disabled={busy} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 hover:text-sky-300 disabled:opacity-50">
                    Rename
                  </button>
                  <button onClick={() => void destroy(g)} disabled={busy} className="rounded-lg border border-rose-900 px-3 py-1.5 text-xs text-rose-300 hover:border-rose-500 disabled:opacity-50">
                    Delete
                  </button>
                </div>
              </div>
              {open?.groupId === g.groupId && (
                <div className="mt-3 border-t border-slate-800 pt-3">
                  <button onClick={() => void removePhones(open)} disabled={busy} className="mb-2 rounded-lg border border-rose-900 px-2 py-1 text-xs text-rose-300 hover:border-rose-500 disabled:opacity-50">
                    Remove numbers…
                  </button>
                  <div className="max-h-56 overflow-y-auto rounded-lg bg-slate-950 p-3">
                    <p className="font-mono text-xs leading-relaxed text-slate-300">{open.phones.join("\n")}</p>
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
