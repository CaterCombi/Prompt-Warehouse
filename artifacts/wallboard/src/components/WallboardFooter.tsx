import { useEffect, useState } from "react";

interface WallboardFooterProps {
  lastUpdated?: string;
  dataUpdatedAt?: number;
}

export default function WallboardFooter({ lastUpdated, dataUpdatedAt }: WallboardFooterProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  // Data is considered delayed if it's older than 3 minutes
  const isDelayed = dataUpdatedAt ? (now - dataUpdatedAt > 3 * 60 * 1000) : false;

  const timeString = lastUpdated 
    ? new Date(lastUpdated).toLocaleTimeString("en-GB", {
        timeZone: "Europe/London",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "—";

  return (
    <footer className="h-10 shrink-0 bg-background/50 border-t border-border flex items-center px-8 justify-between">
      <div className="text-muted-foreground font-medium text-lg">
        Last updated: {timeString}
      </div>
      
      {isDelayed && (
        <div className="text-accent font-bold text-lg flex items-center gap-2 animate-pulse">
          <span>⚠</span> Live data delayed
        </div>
      )}
    </footer>
  );
}
