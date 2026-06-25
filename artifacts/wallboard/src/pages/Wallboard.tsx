import { useEffect, useState, useRef } from "react";
import { useGetDashboard, getGetDashboardQueryKey } from "@workspace/api-client-react";
import WallboardHeader from "@/components/WallboardHeader";
import WallboardFooter from "@/components/WallboardFooter";
import OvenList from "@/components/OvenList";
import EngineerList from "@/components/EngineerList";
import AnimatedNumber from "@/components/AnimatedNumber";
import { useQueryClient } from "@tanstack/react-query";

export default function Wallboard() {
  const queryClient = useQueryClient();
  const { data, dataUpdatedAt, refetch } = useGetDashboard({
    query: {
      refetchInterval: 60000,
      queryKey: getGetDashboardQueryKey(),
    },
  });

  const [cursorHidden, setCursorHidden] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-hide cursor on inactivity
  useEffect(() => {
    const handleMouseMove = () => {
      setCursorHidden(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setCursorHidden(true);
      }, 5000);
    };

    window.addEventListener("mousemove", handleMouseMove);
    handleMouseMove(); // start initial timeout

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Full page reload every 10 minutes (keeps wall-mounted screen fresh)
  useEffect(() => {
    const timer = setInterval(() => {
      window.location.reload();
    }, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // Keyboard shortcut for forcing refetch
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "r") {
        refetch();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [refetch]);

  return (
    <div 
      className={`min-h-screen w-full flex flex-col bg-background text-foreground overflow-hidden ${cursorHidden ? "cursor-none" : ""}`}
    >
      <WallboardHeader />

      <main className="flex-1 flex px-8 py-3 gap-12 overflow-hidden h-[calc(100vh-140px)]">
        {/* Column 1: Shipping Today */}
        <section className="flex-1 flex flex-col gap-3 max-w-[40%]">
          <header className="flex flex-col gap-1">
            <h2 className="text-xl font-black text-primary tracking-widest uppercase">Shipping Today</h2>
            <div className="flex items-center">
              <AnimatedNumber 
                value={data?.shippingToday?.length ?? 0} 
                className="text-6xl font-black text-primary bg-primary/15 px-5 py-1 rounded-xl border-4 border-primary/50"
              />
            </div>
          </header>
          
          <div className="flex-1 overflow-hidden relative">
            {data && data.shippingToday.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <p className="text-4xl text-muted-foreground font-medium">Nothing shipping today</p>
              </div>
            ) : (
              <OvenList items={data?.shippingToday ?? []} color="primary" showAdditionalInfo />
            )}
          </div>
        </section>

        {/* Column 2: Priority Ovens */}
        <section className="flex-1 flex flex-col gap-3 max-w-[40%]">
          <header className="flex flex-col gap-1">
            <h2 className="text-xl font-black text-accent tracking-widest uppercase">Priority Ovens</h2>
            <div className="flex items-center">
              <AnimatedNumber 
                value={data?.priorityOvens?.length ?? 0} 
                className="text-6xl font-black text-accent bg-accent/15 px-5 py-1 rounded-xl border-4 border-accent/50"
              />
            </div>
          </header>
          
          <div className="flex-1 overflow-hidden relative">
            {data && data.priorityOvens.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4">
                <svg className="w-24 h-24 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-4xl font-medium">All clear</p>
              </div>
            ) : (
              <OvenList items={data?.priorityOvens ?? []} color="accent" showAdditionalInfo />
            )}
          </div>
        </section>

        {/* Column 3: Engineer KPI + Total Ovens Fixed */}
        <section className="w-[20%] flex flex-col gap-3">
          <header className="flex flex-col gap-1">
            <h2 className="text-xl font-black text-primary tracking-widest uppercase">Ovens Fixed</h2>
            <div className="flex items-center">
              <AnimatedNumber
                value={data?.totalOvensFixed ?? 0}
                className="text-6xl font-black text-primary bg-primary/15 px-5 py-1 rounded-xl border-4 border-primary/50"
              />
            </div>
          </header>

          <div className="flex-1 overflow-hidden">
            <EngineerList stats={data?.engineerStats ?? []} />
          </div>
        </section>
      </main>

      <WallboardFooter lastUpdated={data?.lastUpdated} dataUpdatedAt={dataUpdatedAt} />
    </div>
  );
}
