import { Button, Modal } from "../ui/kit";

export interface SpendRequest {
  title: string;
  what: string;
  price: number;
  balance: number;
  /** This level's first-clear reward before anything is spent, or null on a replay. */
  reward: number | null;
  /** Coins already spent in this attempt. */
  spent: number;
  /** Extra game-specific line under the standard warning. */
  note?: string;
}

/** Every coin spend goes through this dialog: price, balance after, and what it does to the reward. */
export function ConfirmSpend({
  request,
  busy,
  onConfirm,
  onCancel,
}: {
  request: SpendRequest | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const r = request;
  const after = r ? r.balance - r.price : 0;
  const short = r ? r.price > r.balance : false;
  const rewardNow = r && r.reward !== null ? Math.max(r.reward - r.spent, 0) : null;
  const rewardAfter = r && r.reward !== null ? Math.max(r.reward - r.spent - r.price, 0) : null;
  return (
    <Modal open={r !== null} onClose={onCancel} title={r ? `Use ${r.title}?` : ""}>
      {r && (
        <div className="grid gap-4">
          <p className="text-muted">{r.what}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-2xl bg-panel-2 p-4 text-sm">
            <dt className="text-muted">Price</dt>
            <dd className="text-right font-bold text-gold">{r.price} coins</dd>
            <dt className="text-muted">Your coins</dt>
            <dd className="text-right tabular-nums">
              {r.balance} → <span className={short ? "text-red-300" : "font-bold"}>{short ? "not enough" : after}</span>
            </dd>
            {rewardNow !== null && rewardAfter !== null && (
              <>
                <dt className="text-muted">Reward for this level</dt>
                <dd className="text-right tabular-nums">
                  {rewardNow} → <span className="font-bold">{rewardAfter}</span>
                </dd>
              </>
            )}
          </dl>
          <p className="text-xs text-muted">
            Coins spent are taken off this level's reward and aren't refunded.{r.note ? ` ${r.note}` : ""}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={onConfirm} disabled={busy || short}>
              {busy ? "…" : `Pay ${r.price}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
