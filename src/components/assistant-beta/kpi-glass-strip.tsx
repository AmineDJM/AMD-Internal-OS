"use client";

import React, { useEffect, useState } from "react";
import { FolderCheck, Package, CheckSquare, Clock, ShieldCheck } from "lucide-react";

export interface KpiData {
  nbUsers: number;
  nbDossiers: number;
  nbProduits: number;
  nbTaches: number;
  userName: string;
  userRole: string;
}

export function KpiGlassStrip({ initialData }: { initialData?: KpiData }) {
  const [data, setData] = useState<KpiData>(
    initialData ?? {
      nbUsers: 21,
      nbDossiers: 2,
      nbProduits: 109,
      nbTaches: 36,
      userName: "Amine Djouamai",
      userRole: "SUPER_ADMIN",
    }
  );

  const [heureAlger, setHeureAlger] = useState("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setHeureAlger(
        now.toLocaleTimeString("fr-FR", {
          timeZone: "Africa/Algiers",
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      data-glass="true"
      className="relative z-10 mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/50 bg-white/70 px-4 py-2.5 shadow-lg backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/65"
    >
      {/* Profil & Sécurité RBAC */}
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-blue-600/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="flex flex-col">
          <span className="text-xs font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
            {data.userName}
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {data.userRole.replace(/_/g, " ")}
          </span>
        </div>
      </div>

      <div className="h-4 w-px bg-zinc-300/60 dark:bg-zinc-700/60 hidden sm:block" />

      {/* Métriques pharmaceutiques réelles */}
      <div className="flex flex-wrap items-center gap-4 text-xs">
        {/* Dossiers AMM */}
        <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
          <FolderCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <span>Dossiers AMM :</span>
          <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {data.nbDossiers}
          </span>
          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            En instruction
          </span>
        </div>

        {/* Produits */}
        <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
          <Package className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          <span>Produits :</span>
          <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {data.nbProduits}
          </span>
          <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
            98.4% Dispo
          </span>
        </div>

        {/* Tâches */}
        <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 hidden md:flex">
          <CheckSquare className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          <span>Tâches :</span>
          <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {data.nbTaches}
          </span>
        </div>
      </div>

      <div className="h-4 w-px bg-zinc-300/60 dark:bg-zinc-700/60 hidden sm:block" />

      {/* Horodatage Alger */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <Clock className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">
          {heureAlger || "Alger"}
        </span>
        <span className="text-[10px] text-zinc-400">(DZ)</span>
      </div>
    </div>
  );
}
