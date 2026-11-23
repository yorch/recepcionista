export function PageHeader({
  title, subtitle, right, eyebrow,
}: { title: string; subtitle?: string; right?: React.ReactNode; eyebrow?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow ? <p className="text-xs uppercase tracking-wider text-dim">{eyebrow}</p> : null}
        <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-white">{title}</h1>
        {subtitle ? <p className="mt-1 text-[13px] text-mute">{subtitle}</p> : null}
      </div>
      {right}
    </header>
  );
}
