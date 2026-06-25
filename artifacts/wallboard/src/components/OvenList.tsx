import { useState, useEffect, useRef } from "react";
import type { OvenItem } from "@workspace/api-client-react";

interface OvenListProps {
  items: OvenItem[];
  color: "primary" | "accent";
  showAdditionalInfo?: boolean;
}

const ITEMS_PER_PAGE = 8;

function itemDetails(item: OvenItem): string {
  return [item.manufacturer, item.model, item.size, item.fuel]
    .filter((v): v is string => !!v?.trim())
    .join(" · ");
}

export default function OvenList({ items, color, showAdditionalInfo }: OvenListProps) {
  const [page, setPage] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

  useEffect(() => {
    if (totalPages <= 1) {
      setPage(0);
      return;
    }

    const timer = setInterval(() => {
      setPage((p) => (p + 1) % totalPages);
    }, 8000);

    return () => clearInterval(timer);
  }, [totalPages, items]);

  const visibleItems = items.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const isAccent = color === "accent";

  return (
    <div className="h-full flex flex-col relative" ref={containerRef}>
      <div
        className="flex-1 flex flex-col gap-2 transition-opacity duration-1000"
        key={page}
      >
        {visibleItems.map((item, idx) => {
          const details = itemDetails(item);
          const normalUrgency = item.urgency?.toLowerCase().replace(/-/g, "") ?? "";
          const isUrgent = normalUrgency === "urgent";
          const isRetest = normalUrgency === "retest";
          const borderColor = isUrgent
            ? "border-red-500"
            : isRetest
            ? "border-blue-500"
            : isAccent
            ? "border-accent"
            : "border-primary";
          return (
            <div
              key={`${item.title}-${idx}`}
              className={`bg-card border-l-8 ${borderColor} rounded-r-xl p-3 shadow-md flex items-center justify-between`}
              style={{ animation: `fadeIn 0.5s ease-out ${idx * 0.1}s both` }}
            >
              <div className="flex flex-col truncate pr-3">
                <h3 className="text-2xl font-bold text-foreground truncate leading-tight">
                  {item.title}
                </h3>
                {details ? (
                  <p className="text-sm text-muted-foreground truncate">
                    {details}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground/50 italic">
                    No details
                  </p>
                )}
                {showAdditionalInfo && item.additionalInfo && (
                  <p className="text-sm text-foreground/70 truncate mt-0.5">
                    {item.additionalInfo}
                  </p>
                )}
              </div>

              {isUrgent && (
                <div className="shrink-0 bg-red-100 border-2 border-red-500 text-red-600 px-3 py-1 rounded-lg text-sm font-black uppercase tracking-widest">
                  Urgent
                </div>
              )}
              {isRetest && (
                <div className="shrink-0 bg-blue-100 border-2 border-blue-500 text-blue-600 px-3 py-1 rounded-lg text-sm font-black uppercase tracking-widest">
                  Re-Test
                </div>
              )}
              {!isUrgent && !isRetest && item.status.toLowerCase() === "priority" && (
                <div className="shrink-0 bg-accent/20 border-2 border-accent text-accent px-3 py-1 rounded-lg text-sm font-black uppercase tracking-widest">
                  Priority
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination Indicators */}
      {totalPages > 1 && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-center gap-3 pb-2 pt-6 bg-gradient-to-t from-background to-transparent">
          {Array.from({ length: totalPages }).map((_, i) => (
            <div
              key={i}
              className={`h-3 rounded-full transition-all duration-500 ${
                i === page
                  ? `w-12 ${isAccent ? "bg-accent" : "bg-primary"}`
                  : "w-3 bg-muted-foreground/30"
              }`}
            />
          ))}
        </div>
      )}

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
