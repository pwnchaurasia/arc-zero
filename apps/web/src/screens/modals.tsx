import { useState } from "react";

import { ApiError, api, guestTicket } from "../api/client";
import { proveWork } from "../engine/pow";
import { updateSettings, useSettings } from "../state/settings";
import { useSession } from "../state/session";
import { CopyIcon } from "../ui/icons";
import { Button, Modal, Toggle } from "../ui/kit";

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/** The Level-3 gate: create an account (no email, no password) and show the recovery key once. */
export function CheckpointModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useSession();
  const [step, setStep] = useState<"intro" | "working" | "key">("intro");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
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
    setSaved(false);
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
      {step === "key" && (
        <div className="space-y-4">
          <p className="text-muted">
            This is your key. It is shown <strong className="text-white">only once</strong>. Write
            it down or keep it in a password manager.
          </p>
          <p className="selectable rounded-2xl bg-ink p-4 text-center font-mono text-lg leading-relaxed text-gold">
            {key.split("-").join(" · ")}
          </p>
          <Button
            variant="secondary"
            className="w-full"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(key);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <CopyIcon size={18} /> {copied ? "Copied" : "Copy key"}
          </Button>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-5 accent-sky-400"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            I have saved my key somewhere safe.
          </label>
          <Button className="w-full" disabled={!saved} onClick={finish}>
            Continue playing
          </Button>
        </div>
      )}
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

  return (
    <Modal open={open} onClose={onClose} title="Settings">
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
                  setConfirmSignOut(false);
                  onClose();
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
        <Button variant="ghost" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
