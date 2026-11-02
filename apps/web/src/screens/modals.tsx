import { useState } from "react";

import { ApiError, api, guestTicket } from "../api/client";
import { proveWork } from "../engine/pow";
import { updateSettings, useSettings } from "../state/settings";
import { useSession } from "../state/session";
import { CopyIcon } from "../ui/icons";
import { Button, Modal, Toggle } from "../ui/kit";
import { keyFileText, keyWords, wordMatches } from "./recoveryKey";

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/**
 * Shows a recovery key once. "Continue" unlocks only after the player types one of
 * the words back, so the key can't be skipped by ticking a box without saving it.
 */
function KeyReveal({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const words = keyWords(recoveryKey);
  const [ask] = useState(() => Math.floor(Math.random() * words.length));
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);
  const confirmed = wordMatches(words, ask, typed);

  const download = () => {
    const blob = new Blob([keyFileText(recoveryKey, window.location.origin)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "arc-zero-recovery-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <p className="text-muted">
        This is your key. It is shown <strong className="text-white">only once</strong>. Write it
        down, keep it in a password manager, or download it.
      </p>
      <ol className="selectable grid grid-cols-2 gap-2 rounded-2xl bg-ink p-4 font-mono text-gold">
        {words.map((w, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-4 text-right text-muted">{i + 1}</span>
            <span>{w}</span>
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(recoveryKey);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <CopyIcon size={18} /> {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" onClick={download}>
          Download
        </Button>
      </div>
      <label className="block space-y-2 text-sm">
        <span>
          To confirm you saved it, type word <strong className="text-white">#{ask + 1}</strong>
        </span>
        <input
          className="selectable w-full rounded-xl border border-line bg-ink p-3 font-mono text-white outline-none focus:border-accent"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      <Button className="w-full" disabled={!confirmed} onClick={onDone}>
        Continue
      </Button>
    </div>
  );
}

/** The Level-3 gate: create an account (no email, no password) and show the recovery key once. */
export function CheckpointModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useSession();
  const [step, setStep] = useState<"intro" | "working" | "key">("intro");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setStep("working");
    setError(null);
    try {
      const pow = await proveWork("register");
      const { recovery_key } = await api.register(pow);
      guestTicket.clear();
      setKey(recovery_key);
      setStep("key");
    } catch (e) {
      setError(message(e));
      setStep("intro");
    }
  };

  const finish = async () => {
    await refresh();
    setStep("intro");
    setKey("");
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Cloud Checkpoint Reached!" dismissable={step !== "key"}>
      {step !== "key" && (
        <div className="space-y-4">
          <p className="text-muted">
            Nice work. Save your progress to keep playing. No email, no password: you get a
            six-word key that restores your progress on any device.
          </p>
          {error && <p className="rounded-xl bg-red-500/15 p-3 text-sm text-red-300">{error}</p>}
          <Button className="w-full" onClick={save} disabled={step === "working"}>
            {step === "working" ? "Securing your account…" : "Save my progress"}
          </Button>
          <Button variant="ghost" className="w-full" onClick={onClose} disabled={step === "working"}>
            Not now
          </Button>
        </div>
      )}
      {step === "key" && <KeyReveal recoveryKey={key} onDone={finish} />}
    </Modal>
  );
}

export function RestoreModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useSession();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.restore(value, await proveWork("restore"));
      guestTicket.clear();
      await refresh();
      setValue("");
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Restore progress">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-muted">Enter the six-word key you saved.</p>
        <textarea
          className="selectable w-full resize-none rounded-2xl border border-line bg-ink p-3 font-mono text-white outline-none focus:border-accent"
          rows={2}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          placeholder="word word word word word word"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <p className="rounded-xl bg-red-500/15 p-3 text-sm text-red-300">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || value.trim().length < 10}>
          {busy ? "Checking…" : "Restore"}
        </Button>
      </form>
    </Modal>
  );
}

export function SettingsModal({
  open,
  onClose,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  onRestore: () => void;
}) {
  const settings = useSettings();
  const { me, refresh } = useSession();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [keyStep, setKeyStep] = useState<"idle" | "confirm" | "working">("idle");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const close = () => {
    setKeyStep("idle");
    setNewKey(null);
    setKeyError(null);
    setConfirmSignOut(false);
    onClose();
  };

  const createKey = async () => {
    setKeyStep("working");
    setKeyError(null);
    try {
      setNewKey((await api.newRecoveryKey()).recovery_key);
    } catch (e) {
      setKeyError(message(e));
    } finally {
      setKeyStep("idle");
    }
  };

  if (newKey) {
    return (
      <Modal open={open} onClose={close} title="Your new recovery key" dismissable={false}>
        <KeyReveal recoveryKey={newKey} onDone={close} />
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title="Settings">
      <div className="space-y-1">
        <Toggle label="Sound" checked={settings.sound} onChange={(v) => updateSettings({ sound: v })} />
        <Toggle
          label="Vibration"
          checked={settings.haptics}
          onChange={(v) => updateSettings({ haptics: v })}
        />
        <Toggle
          label="Colour symbols"
          checked={settings.colorSymbols}
          onChange={(v) => updateSettings({ colorSymbols: v })}
        />
      </div>
      <div className="mt-6 space-y-3 border-t border-line pt-5">
        {me?.signed_in &&
          (keyStep === "idle" ? (
            <Button variant="secondary" className="w-full" onClick={() => setKeyStep("confirm")}>
              Lost your key? Create a new one…
            </Button>
          ) : (
            <div className="space-y-3 rounded-2xl border border-line p-4">
              <p className="text-sm text-muted">
                A new six-word key will replace your current one, which stops working. Save the
                new one before you sign out.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="ghost" onClick={() => setKeyStep("idle")} disabled={keyStep === "working"}>
                  Cancel
                </Button>
                <Button onClick={createKey} disabled={keyStep === "working"}>
                  {keyStep === "working" ? "Creating…" : "Create new key"}
                </Button>
              </div>
            </div>
          ))}
        {keyError && <p className="rounded-xl bg-red-500/15 p-3 text-sm text-red-300">{keyError}</p>}
        {me?.signed_in ? (
          confirmSignOut ? (
            <>
              <p className="text-sm text-muted">
                You will need your six-word key to sign back in on this device.
              </p>
              <Button
                variant="secondary"
                className="w-full"
                onClick={async () => {
                  await api.logout().catch(() => undefined);
                  await refresh();
                  close();
                }}
              >
                Sign out
              </Button>
            </>
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setConfirmSignOut(true)}>
              Sign out…
            </Button>
          )
        ) : (
          <Button variant="secondary" className="w-full" onClick={onRestore}>
            I have a key: restore progress
          </Button>
        )}
        <Button variant="ghost" className="w-full" onClick={close}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
