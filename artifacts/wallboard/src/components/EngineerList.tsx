import type { EngineerStat } from "@workspace/api-client-react";

interface EngineerListProps {
  stats: EngineerStat[];
}

export default function EngineerList({ stats }: EngineerListProps) {
  if (!stats.length) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-2xl text-muted-foreground">No data</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 h-full">
      {stats.map((s, idx) => (
        <div
          key={s.name}
          className="bg-card border-l-8 border-primary rounded-r-xl px-4 py-3 shadow-md flex items-center justify-between"
          style={{ animation: `fadeIn 0.4s ease-out ${idx * 0.08}s both` }}
        >
          <span className="text-lg font-semibold text-foreground truncate pr-3">
            {s.name}
          </span>
          <span className="text-3xl font-black text-primary shrink-0">
            {s.kpi.toFixed(2)}
          </span>
        </div>
      ))}

      <div className="mt-auto pt-3 border-t border-border text-center">
        <h2 className="text-xl font-black text-primary tracking-widest uppercase">KPI</h2>
        <p className="text-sm text-muted-foreground uppercase tracking-widest">This Month</p>
      </div>
    </div>
  );
}
