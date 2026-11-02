"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  alignerCompteSurFiche, alignerToutSurOrganigramme, rattacherBuAuDepartement,
  designerResponsableDepartement, appliquerSuperviseurPropose,
} from "@/lib/actions/org-coherence-actions";
import { assignEmployeeDepartment } from "@/lib/actions/department-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Badge } from "@/components/ui/badge";
import type { Coherence } from "@/lib/org/coherence";

/**
 * « CONTRÔLE DE COHÉRENCE » — ce qui contredit l'organigramme aujourd'hui, et le geste qui le corrige (Super Admin).
 * Chaque rubrique se déplie ; chaque ligne a son bouton. Les données arrivent calculées du serveur (`coherence.ts`).
 */

type Opt = { id: string; name: string };
type Action = (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>;

const sel = "h-9 max-w-full rounded-lg border border-input bg-background px-2 text-sm";
const btn = "inline-flex items-center gap-1 rounded-lg border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-60";

export function CoherencePanel({ coherence, departements, employes, nomsComptes }: {
  coherence: Coherence;
  departements: Opt[];
  employes: { id: string; name: string; departmentId: string | null }[];
  nomsComptes: Record<string, string>;
}) {
  const { enCours, rafraichir } = useRafraichir();
  // Les gestes du panneau vivent dans des lignes, sans place où parler : un refus part en avis flottant.
  const retours = useRetours();
  const [occupe, setOccupe] = React.useState(false);
  const busy = occupe || enCours;

  async function run(action: Action, champs: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    setOccupe(true);
    try {
      const r = await action(fd);
      if (!r.ok) { retours.erreur(r.error ?? "La correction n'a pas été appliquée."); return; }
      rafraichir();
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(false);
    }
  }

  const c = coherence;
  return (
    <section className="surface overflow-hidden" aria-labelledby="coherence-titre">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 id="coherence-titre" className="text-base font-semibold">Contrôle de cohérence</h2>
          <InfoBulle label="À quoi sert ce contrôle">
            L&apos;organigramme est la seule source : départements, responsables, N+1. Ce qui le redit ailleurs (compte,
            libellé de la fiche, BU, superviseur) doit le suivre. Chaque ligne se corrige d&apos;un clic, et c&apos;est audité.
          </InfoBulle>
        </div>
        {(c.comptesDivergents.length > 0 || c.libellesPerimes.length > 0) && (
          <button type="button" className={btn} disabled={busy} onClick={() => run(alignerToutSurOrganigramme, {})}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Tout aligner sur l&apos;organigramme
          </button>
        )}
      </header>

      <Rubrique titre="comptes dont le département diffère de la fiche salarié" n={c.comptesDivergents.length} ton="warning">
        {c.comptesDivergents.map((x) => (
          <Ligne key={x.userId} texte={x.nom} detail={`compte : ${x.compte ?? "—"} · fiche : ${x.fiche ?? "—"}`}>
            <button type="button" className={btn} disabled={busy} onClick={() => run(alignerCompteSurFiche, { employeeId: x.employeeId })}>Corriger</button>
          </Ligne>
        ))}
      </Rubrique>

      <Rubrique titre="fiches dont le libellé de département est périmé" n={c.libellesPerimes.length} ton="warning">
        {c.libellesPerimes.map((x) => (
          <Ligne key={x.employeeId} texte={x.nom} detail={`« ${x.libelle ?? "—"} » → « ${x.attendu} »`}>
            <button type="button" className={btn} disabled={busy} onClick={() => run(alignerToutSurOrganigramme, {})}>Corriger</button>
          </Ligne>
        ))}
      </Rubrique>

      <Rubrique titre="BU sans département rattaché" n={c.buSansDepartement.length} ton="warning">
        {c.buSansDepartement.map((x) => (
          <ChoixLigne key={x.buId} texte={x.nom} options={departements} placeholder="— Département —" bouton="Rattacher" busy={busy}
            onValider={(departmentId) => run(rattacherBuAuDepartement, { businessUnitId: x.buId, departmentId })} />
        ))}
      </Rubrique>

      <Rubrique titre="départements sans responsable" n={c.departementsSansResponsable.length} ton="danger">
        {c.departementsSansResponsable.map((x) => {
          const membres = employes.filter((e) => e.departmentId === x.departmentId);
          return (
            <ChoixLigne key={x.departmentId} texte={x.nom} detail={`${x.membres} membre(s)`}
              options={(membres.length ? membres : employes).map((e) => ({ id: e.id, name: e.name }))}
              placeholder="— Responsable —" bouton="Désigner" busy={busy}
              onValider={(employeeId) => run(designerResponsableDepartement, { departmentId: x.departmentId, employeeId })} />
          );
        })}
      </Rubrique>

      <Rubrique titre="superviseurs de BU hors de la ligne hiérarchique de leurs KAM" n={c.superviseursHorsLigne.length} ton="warning">
        {c.superviseursHorsLigne.map((x) => (
          <Ligne key={x.buId} texte={`${x.nom} · ${nomsComptes[x.superviseurId] ?? "superviseur"}`} detail={`hors ligne pour : ${x.kamsHorsLigne.join(", ")}`}>
            {x.propose ? (
              <button type="button" className={btn} disabled={busy} onClick={() => run(appliquerSuperviseurPropose, { businessUnitId: x.buId })}>
                Remplacer par {nomsComptes[x.propose] ?? "le responsable"}
              </button>
            ) : (
              <a className={btn} href={`/business-units?bu=${encodeURIComponent(x.buId)}`}>Vérifier</a>
            )}
          </Ligne>
        ))}
      </Rubrique>

      <Rubrique titre="employés sans département" n={c.employesSansDepartement.length} ton="warning">
        {c.employesSansDepartement.map((x) => (
          <ChoixLigne key={x.employeeId} texte={x.nom} options={departements} placeholder="— Département —" bouton="Rattacher" busy={busy}
            onValider={(departmentId) => run(assignEmployeeDepartment, { employeeId: x.employeeId, departmentId })} />
        ))}
      </Rubrique>
    </section>
  );
}

function Rubrique({ titre, n, ton, children }: { titre: string; n: number; ton: "warning" | "danger"; children: React.ReactNode }) {
  const [ouvert, setOuvert] = React.useState(false);
  if (n === 0) {
    return <div className="border-b border-border px-4 py-2.5 text-sm text-muted-foreground last:border-b-0">0 {titre} <Badge tone="success" dot={false}>ok</Badge></div>;
  }
  return (
    <div className="border-b border-border last:border-b-0">
      <button type="button" onClick={() => setOuvert((o) => !o)} aria-expanded={ouvert}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-secondary/50">
        {ouvert ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1"><span className="font-semibold tabular-nums">{n}</span> {titre}</span>
        <Badge tone={ton} dot={false}>{ton === "danger" ? "désigner" : "corriger"}</Badge>
      </button>
      {ouvert && <ul className="space-y-1 px-4 pb-3">{children}</ul>}
    </div>
  );
}

function Ligne({ texte, detail, children }: { texte: string; detail?: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {texte}{detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </span>
      {children}
    </li>
  );
}

function ChoixLigne({ texte, detail, options, placeholder, bouton, busy, onValider }: {
  texte: string; detail?: string; options: Opt[]; placeholder: string; bouton: string; busy: boolean; onValider: (id: string) => void;
}) {
  const [choix, setChoix] = React.useState("");
  return (
    <Ligne texte={texte} detail={detail}>
      <select className={sel} value={choix} onChange={(e) => setChoix(e.target.value)} aria-label={placeholder}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <button type="button" className={btn} disabled={busy || !choix} onClick={() => onValider(choix)}>{bouton}</button>
    </Ligne>
  );
}
