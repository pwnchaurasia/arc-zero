import { Button, Modal } from "../ui/kit";

function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" className="inline align-[-3px]">
      <path d="M12 3v12M8 7l4-4 4 4M6 11v9h12v-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Safari on iPhone/iPad can't be prompted to install, so we show the three taps instead. */
export function IosInstallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Install Arc Zero">
      <ol className="mb-5 grid gap-3 text-sm">
        <li className="flex gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent font-bold text-ink">1</span>
          <span>
            Tap <b>Share</b> <ShareGlyph /> in Safari's toolbar (at the bottom on iPhone, top on iPad).
          </span>
        </li>
        <li className="flex gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent font-bold text-ink">2</span>
          <span>
            Scroll down and tap <b>Add to Home Screen</b>.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent font-bold text-ink">3</span>
          <span>
            Tap <b>Add</b>. Arc Zero opens full screen from your home screen, like an app.
          </span>
        </li>
      </ol>
      <p className="mb-4 text-xs text-muted">Using Chrome on iPhone? Open this page in Safari first.</p>
      <Button className="w-full" onClick={onClose}>
        Got it
      </Button>
    </Modal>
  );
}
