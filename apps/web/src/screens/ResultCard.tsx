import { Button, Stars } from "../ui/kit";

export function ResultCard({
  won,
  stars,
  detail,
  hasNext,
  onNext,
  onRetry,
  onLevels,
}: {
  won: boolean;
  stars: number;
  detail?: string;
  hasNext: boolean;
  onNext: () => void;
  onRetry: () => void;
  onLevels: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-ink/70 p-6 backdrop-blur-sm">
      <div className="pop-in w-full max-w-sm rounded-3xl border border-line bg-panel p-6 text-center">
        <h2 className="text-3xl font-black">{won ? "Level clear!" : "Game over"}</h2>
        {won && (
          <div className="my-4 flex justify-center">
            <Stars count={stars} size={44} />
          </div>
        )}
        {detail && <p className="mb-4 text-muted">{detail}</p>}
        <div className="grid gap-3">
          {won && hasNext && <Button onClick={onNext}>Next level</Button>}
          <Button variant={won ? "secondary" : "primary"} onClick={onRetry}>
            {won ? "Play again" : "Try again"}
          </Button>
          <Button variant="ghost" onClick={onLevels}>
            All levels
          </Button>
        </div>
      </div>
    </div>
  );
}
