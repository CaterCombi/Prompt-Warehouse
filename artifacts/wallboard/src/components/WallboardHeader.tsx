import { useEffect, useState } from "react";
import logo from "../assets/catercombi-logo.png";

export default function WallboardHeader() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const timeString = time.toLocaleTimeString("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const dateString = time.toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <header className="flex items-center justify-between px-8 py-6 border-b-2 border-border/50 bg-card shadow-lg z-10 shrink-0 h-[100px]">
      <div className="flex items-center">
        <img src={logo} alt="CaterCombi" className="h-16 w-auto" />
      </div>
      
      <div className="flex flex-col items-end justify-center">
        <div className="text-5xl font-black tracking-tight text-foreground font-mono tabular-nums leading-none">
          {timeString}
        </div>
        <div className="text-xl font-bold text-muted-foreground uppercase tracking-widest mt-1">
          {dateString}
        </div>
      </div>
    </header>
  );
}
