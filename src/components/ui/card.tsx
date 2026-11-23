import { cn } from './cn';

export function Card({ className, children, ...rest }: { className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('rounded-2xl border border-line bg-panel/80 backdrop-blur-sm', className)}>
      {children}
    </div>
  );
}

export function CardHead({
  title, subtitle, right, as: Tag = 'h2',
}: { title: string; subtitle?: string; right?: React.ReactNode; as?: 'h2' | 'h3' }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        <Tag className="text-sm font-semibold tracking-tight text-white">{title}</Tag>
        {subtitle ? <p className="mt-0.5 text-xs text-mute">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}
