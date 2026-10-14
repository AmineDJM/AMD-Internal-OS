"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { chapeauxDe, montantDzd, type LigneLot, type Lot } from "@/lib/espace/aujourdhui";

/**
 * « À FAIRE MAINTENANT » — la file groupée par lot (Direction, 14/10/2026).
 *
 * Un lot = une ligne de titre concrète, un geste principal, et ses sous-lignes à déplier (rangées par
 * famille quand la donnée en porte une). Chaque geste MÈNE à l'écran où il se fait — celui qui porte
 * sa garde, ses pièces, sa confirmation : la file ne décide rien à la place de cet écran. Le composant
 * ne lit que des données déjà filtrées par les droits de la personne, et un module pur.
 */

const TON_PILE: Record<Lot["ton"], string> = {
  late: "bg-destructive/10 text-destructive",
  warn: "bg-warning/10 text-warning",
  "": "bg-secondary text-foreground",
};

function Pourquoi({ lot }: { lot: Lot }) {
  if (lot.enRetard > 0) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
        {lot.enRetard > 1 ? `${lot.enRetard} en retard · ` : "En retard · "}{lot.retardMax} j
      </span>
    );
  }
  if ((lot.attenteMax ?? 0) >= 30) {
    return <span className="inline-flex shrink-0 items-center rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">Attend depuis {lot.attenteMax} j</span>;
  }
  if (lot.attenteMax === 0) {
    return <span className="inline-flex shrink-0 items-center rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-foreground">Aujourd&apos;hui</span>;
  }
  return null;
}

function Ligne({ l, enAvant }: { l: LigneLot; enAvant: boolean }) {
  return (
    <li className="flex flex-col gap-1.5 border-t border-border py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {l.ref && <span className="font-mono text-xs text-muted-foreground">{l.ref}</span>}
          <span className="min-w-0 break-words text-sm">{l.libelle}</span>
        </div>
        {l.detail && <p className="break-words text-xs text-muted-foreground">{l.detail}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {l.montant !== null && l.montant > 0 && <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{montantDzd(l.montant)}</span>}
        {l.retard !== null ? (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">{l.retard} j de retard</span>
        ) : l.attente !== null && l.attente >= 30 ? (
          <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">{l.attente} j</span>
        ) : l.attente ? (
          <span className="text-xs tabular-nums text-muted-foreground">{l.attente} j</span>
        ) : null}
        <Link
          href={l.geste.href}
          className={cn(
            "inline-flex h-9 items-center rounded-[var(--radius)] px-3 text-xs font-medium transition-colors focus-ring sm:h-8",
            enAvant ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border bg-card hover:bg-secondary",
          )}
        >
          {l.geste.libelle}
        </Link>
      </div>
    </li>
  );
}

function LotCarte({ lot, ouvert, basculer }: { lot: Lot; ouvert: boolean; basculer: () => void }) {
  const plusieurs = lot.n > 1;
  const idLignes = `lot-${lot.id}-lignes`;
  const familles = lot.familles.length > 1 ? lot.familles : [];
  return (
    <article className="border-t border-border first:border-t-0">
      <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[44px_minmax(0,1fr)_auto]">
        <div className={cn("row-span-2 grid h-10 w-10 place-items-center self-start rounded-xl text-base font-bold tabular-nums sm:h-11 sm:w-11", TON_PILE[lot.ton])} aria-hidden>
          {lot.n || "…"}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 break-words text-[15px] font-semibold leading-snug">{lot.titre}</h3>
          <Pourquoi lot={lot} />
          <span className="rounded-md border border-border px-1.5 text-[11px] font-medium text-muted-foreground">{lot.chapeau}</span>
        </div>
        <p className="col-start-2 break-words text-xs text-muted-foreground">
          {lot.sousTitre}
          {plusieurs && lot.attenteMax ? <> · le plus ancien : <b className="font-semibold text-foreground">{lot.attenteMax} j</b></> : null}
        </p>
        <div className="col-span-2 flex flex-wrap items-center gap-2 pt-1 sm:col-span-1 sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:justify-end sm:pt-0">
          {lot.montant > 0 && <span className="whitespace-nowrap text-sm font-bold tabular-nums">{montantDzd(lot.montant)}</span>}
          <Link
            href={lot.geste.href}
            className="inline-flex h-9 items-center gap-1 rounded-[var(--radius)] bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-ring sm:h-8"
          >
            {lot.geste.libelle} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          {plusieurs && (
            <button
              type="button"
              onClick={basculer}
              aria-expanded={ouvert}
              aria-controls={idLignes}
              className="inline-flex h-9 items-center gap-1 rounded-[var(--radius)] px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground focus-ring sm:h-8"
            >
              {ouvert ? <>Replier <ChevronUp className="h-3.5 w-3.5" aria-hidden /></> : <>Tout voir ({lot.n}) <ChevronDown className="h-3.5 w-3.5" aria-hidden /></>}
            </button>
          )}
        </div>
      </div>
      {plusieurs && ouvert && (
        <div id={idLignes} className="px-4 pb-3 sm:pl-[72px]">
          {familles.length > 0 ? (
            familles.map((f) => {
              const lignes = lot.lignes.filter((l) => (l.famille ?? "Autres") === f.famille);
              return (
                <div key={f.famille} className="border-t border-dashed border-border pt-2 first:border-t-0 first:pt-0">
                  <p className="flex flex-wrap gap-x-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <span>{f.famille} · {f.n}</span>
                    {f.montant > 0 && <span className="tabular-nums">{montantDzd(f.montant)}</span>}
                    {f.enRetard > 0 && <span className="text-destructive">{f.enRetard} en retard</span>}
                  </p>
                  <ul>{lignes.map((l) => <Ligne key={l.key} l={l} enAvant={l.retard !== null} />)}</ul>
                </div>
              );
            })
          ) : (
            <ul>{lot.lignes.map((l) => <Ligne key={l.key} l={l} enAvant={l.retard !== null} />)}</ul>
          )}
          {lot.suite && (
            <Link href={lot.suite.href} className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
              {lot.suite.libelle} <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

export function FileAFaire({ lots }: { lots: Lot[] }) {
  const chapeaux = React.useMemo(() => chapeauxDe(lots), [lots]);
  const [filtre, setFiltre] = React.useState<string | null>(null);
  // Le lot le plus pressant s'ouvre de lui-même : c'est par lui qu'on commence.
  const [ouverts, setOuverts] = React.useState<Record<string, boolean>>(() => (lots[0] ? { [lots[0].id]: true } : {}));
  const visibles = filtre ? lots.filter((l) => l.chapeau === filtre) : lots;
  const total = lots.reduce((s, l) => s + l.n, 0);

  return (
    <section aria-labelledby="file-titre" className="min-w-0 rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="file-titre" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">À faire maintenant</h2>
        {chapeaux.length > 2 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrer la file">
            {[{ chapeau: null as string | null, n: total }, ...chapeaux].map((c) => (
              <button
                key={c.chapeau ?? "tout"}
                type="button"
                aria-pressed={filtre === c.chapeau}
                onClick={() => setFiltre(c.chapeau)}
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs font-medium focus-ring",
                  filtre === c.chapeau ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-secondary",
                )}
              >
                {c.chapeau ?? "Tout"} <span className="tabular-nums text-muted-foreground">{c.n}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {visibles.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          <p className="text-base font-semibold text-success">Rien ne vous attend ici.</p>
          Aucun élément n&apos;attend un geste de votre part.
        </div>
      ) : (
        visibles.map((lot) => (
          <LotCarte key={lot.id} lot={lot} ouvert={!!ouverts[lot.id]} basculer={() => setOuverts((o) => ({ ...o, [lot.id]: !o[lot.id] }))} />
        ))
      )}
      <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        Trié par urgence : retard d&apos;abord, puis montant et ancienneté. Chaque geste ouvre l&apos;écran où il se fait.
      </p>
    </section>
  );
}
