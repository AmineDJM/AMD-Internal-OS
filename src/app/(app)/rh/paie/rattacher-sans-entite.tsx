"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Link2, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { formatCurrency } from "@/lib/utils";
import { rattacherSalariesAEntite } from "@/lib/actions/payroll-hr-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { sansBloquer } from "@/lib/journal";

export interface SalarieSansEntite {
  id: string;
  nom: string;
  poste: string | null;
  /** Coût employeur des salaires payés de l'année. */
  cout: number;
  net: number;
  salaires: number;
}

/**
 * LES SALARIÉS SANS ENTITÉ — « me dire QUI, et en un clic je les rattache » (Direction, 04/10/2026).
 *
 * Une ligne d'alerte sur la page de paie (maquette « Paie », 07/10) ; son bouton ouvre le
 * rattachement : un geste par salarié, et un geste pour tous. Le menu ne propose que les entités
 * ouvertes à la personne ; l'action le revérifie. Le rafraîchissement passe par `useRafraichir`
 * (§118.172) : tant que la liste n'est pas à jour, les gestes restent fermés — sinon un second clic
 * partirait sur un salarié déjà rattaché.
 */
export function RattacherSansEntite({
  year, salaries, entites,
}: {
  year: number;
  salaries: SalarieSansEntite[];
  entites: { id: string; label: string }[];
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const [cibles, setCibles] = React.useState<Record<string, string>>({});
  const [cibleTous, setCibleTous] = React.useState("");

  const rattacher = async (cle: string, companyId: string, ids: string[]) => {
    setBusy(cle); setMsg(null);
    const fd = new FormData();
    fd.set("companyId", companyId);
    for (const id of ids) fd.append("employeeIds", id);
    const r = await rattacherSalariesAEntite(fd).catch(sansBloquer("rattacher-sans-entite.rattacher.rattacherSalariesAEntite", { ok: false as const, error: "Le rattachement n'a pas abouti — réessayez.", message: undefined }));
    setBusy(null);
    setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? "Rattaché.") : (r.error ?? "Rattachement refusé.") });
    if (r.ok) rafraichir();
  };

  const total = salaries.reduce((a, s) => a + s.cout, 0);
  const ferme = busy !== null || enCours;
  const n = salaries.length;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 sm:px-4">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <UserX className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-0">
            <strong className="font-semibold">{n} salarié{n > 1 ? "s" : ""} sans entité</strong>
            <span className="text-muted-foreground"> — leur paie ne peut pas partir au centre</span>
          </span>
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => { setMsg(null); setOuvert(true); }}>
          <Link2 className="h-3.5 w-3.5" /> Rattacher
        </Button>
      </div>

      <Sheet
        open={ouvert}
        onClose={() => busy === null && setOuvert(false)}
        title={`Sans entité — à rattacher (${n})`}
        description={`${formatCurrency(total)} de masse ${year} sans entité · rattacher écrit l'entité de la fiche salarié`}
        width="md"
      >
        <div className="space-y-4">
          {entites.length === 0 ? (
            <p className="text-xs text-muted-foreground">Aucune entité ne vous est ouverte : le rattachement se fait depuis une entité que vous voyez.</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex w-full flex-col gap-1 text-xs sm:w-auto">
                <span className="text-muted-foreground">Tout rattacher à…</span>
                <Select value={cibleTous} onChange={(e) => setCibleTous(e.target.value)} className="h-10 w-full text-sm sm:h-9 sm:w-48" aria-label="Entité pour tous les salariés sans entité">
                  <option value="">— Choisir —</option>
                  {entites.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </Select>
              </label>
              <Button
                type="button" size="sm" className="w-full sm:w-auto" disabled={ferme || !cibleTous || n === 0}
                onClick={() => rattacher("tous", cibleTous, salaries.map((s) => s.id))}
              >
                {busy === "tous" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                Tout rattacher ({n})
              </Button>
            </div>
          )}

          <ul className="divide-y divide-border/60 text-sm">
            {salaries.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-salarie={s.nom}>
                <div className="min-w-0">
                  <Link href={`/rh/${s.id}`} className="font-medium [overflow-wrap:anywhere] hover:underline">{s.nom}</Link>
                  <p className="text-xs text-muted-foreground">
                    {s.poste || "Poste non renseigné"} · {s.salaires > 0
                      ? <>{formatCurrency(s.cout)} ({s.salaires} salaire{s.salaires > 1 ? "s" : ""} en {year}, net {formatCurrency(s.net)})</>
                      : <>aucun salaire en {year}</>}
                  </p>
                </div>
                {entites.length > 0 && (
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Select
                      value={cibles[s.id] ?? ""} onChange={(e) => setCibles((c) => ({ ...c, [s.id]: e.target.value }))}
                      className="h-9 min-w-0 flex-1 text-sm sm:w-40 sm:flex-none" aria-label={`Entité de ${s.nom}`}
                    >
                      <option value="">Rattacher à…</option>
                      {entites.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </Select>
                    <Button
                      type="button" size="sm" variant="outline" disabled={ferme || !cibles[s.id]}
                      onClick={() => rattacher(s.id, cibles[s.id]!, [s.id])}
                    >
                      {busy === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Rattacher
                    </Button>
                  </div>
                )}
              </li>
            ))}
            {n === 0 && <li className="py-2 text-xs text-muted-foreground">Tous les salariés sont rattachés.</li>}
          </ul>

          {msg && (
            <p role="status" className={msg.ok ? "rounded-lg bg-success/10 px-3 py-2 text-xs" : "rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"}>
              {msg.texte}
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}
