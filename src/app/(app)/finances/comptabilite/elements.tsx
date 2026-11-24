"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Les petites pièces des panneaux de la Comptabilité — pastilles de choix, champ libellé, boutons, titre de bloc. */

export function Pastilles({ options, valeur, onChoix }: {
  options: readonly { valeur: string; libelle: string }[]; valeur: string; onChoix: (v: string) => void;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.valeur} type="button" role="radio" aria-checked={o.valeur === valeur} onClick={() => onChoix(o.valeur)}
          className={cn("min-h-8 rounded-full border px-[11px] py-1 text-[13px]", o.valeur === valeur ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border bg-card text-muted-foreground")}
        >
          {o.libelle}
        </button>
      ))}
    </div>
  );
}

export function Champ({ id, libelle, facultatif = false, children }: { id?: string; libelle: React.ReactNode; facultatif?: boolean; children: React.ReactNode }) {
  const Etiquette = id ? "label" : "span";
  return (
    <div className="flex flex-col gap-1">
      <Etiquette {...(id ? { htmlFor: id } : {})} className="text-[13px] font-semibold text-muted-foreground">
        {libelle}{facultatif && <span className="font-normal"> (facultatif)</span>}
      </Etiquette>
      {children}
    </div>
  );
}

export function BoutonPrincipal({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={cn("h-[38px] rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50", className)} />;
}

export function BoutonSecondaire({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={cn("h-[38px] rounded-lg border border-border bg-card px-3.5 text-sm font-semibold hover:bg-secondary disabled:opacity-50", className)} />;
}

export function TitreBloc({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)}>{children}</h3>;
}
