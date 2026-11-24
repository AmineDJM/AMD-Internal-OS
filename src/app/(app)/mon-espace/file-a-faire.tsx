"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Sheet } from "@/components/ui/sheet";
import { LeaveApprovals, type PendingLeave } from "@/components/hr/leave-approvals";
import { CHEMIN_MES_MISSIONS } from "@/lib/chemins/espace";
import { libelleDeplier, type AFaire, type GroupeAFaire, type LigneAFaire, type Panneau } from "@/lib/espace/a-faire";

/**
 * « À FAIRE » — la file d'Aujourd'hui (maquette validée par le Super Admin, 24/11/2026).
 *
 * Trois groupes (« En retard », « Aujourd'hui », « Plus tard », ce dernier replié), une ligne = un titre,
 * un sous-titre d'une ligne et UN bouton. Seul « En retard » est en rouge ; un seul bouton plein, celui de
 * la première ligne. Chaque geste MÈNE à l'écran où il se fait (sa garde, ses pièces, sa confirmation) — sauf
 * le congé, qui se décide ICI, dans un panneau qui porte le composant de décision des congés (`LeaveApprovals` :
 * approuver, refuser, note, discussion — la même action `decideLeave`). Le regroupement est une règle pure
 * (`espace/a-faire.ts`) ; ce composant ne lit que des données déjà filtrées par les droits de la personne.
 */

/** L'ancre des notifications « Congé à signer » (`LIEN_CONGES_A_SIGNER`) : elle ouvre le panneau des congés. */
const ANCRE_CONGES = "conges-a-signer";

const bouton = "inline-flex h-10 shrink-0 items-center justify-center rounded-[var(--radius)] px-4 text-sm font-semibold transition-colors focus-ring";
const plein = "bg-primary text-primary-foreground hover:bg-primary/90";
const contour = "border border-border bg-card text-foreground hover:bg-secondary";

function Geste({ ligne, ouvrir }: { ligne: LigneAFaire; ouvrir: ((p: Panneau) => void) | null }) {
  const cls = cn(bouton, ligne.enAvant ? plein : contour);
  if (ligne.panneau && ouvrir) {
    return <button type="button" className={cls} onClick={() => ouvrir(ligne.panneau)}>{ligne.geste.libelle}</button>;
  }
  return <Link href={ligne.geste.href} className={cls}>{ligne.geste.libelle}</Link>;
}

function Ligne({ ligne, ouvrir, ancre }: { ligne: LigneAFaire; ouvrir: ((p: Panneau) => void) | null; ancre: boolean }) {
  const [deplie, setDeplie] = React.useState(false);
  const idDetail = `detail-${ligne.key}`;
  const plusieurs = ligne.sousLignes.length > 0;
  return (
    <li id={ancre ? ANCRE_CONGES : undefined} className="scroll-mt-20 border-t border-border px-4 py-3.5 sm:px-5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[15px] font-semibold leading-snug">{ligne.titre}</p>
          {ligne.sousTitre && <p className="mt-0.5 truncate text-[13px] text-muted-foreground" title={ligne.sousTitre}>{ligne.sousTitre}</p>}
          {plusieurs && (
            <button
              type="button" onClick={() => setDeplie((d) => !d)} aria-expanded={deplie} aria-controls={idDetail}
              className="mt-1 inline-flex min-h-8 items-center text-[13px] font-medium text-primary hover:underline focus-ring"
            >
              {deplie ? "Masquer le détail" : `Voir les ${ligne.n}`}
            </button>
          )}
          {!plusieurs && ligne.suite && (
            <Link href={ligne.suite.href} className="mt-1 inline-flex min-h-8 items-center text-[13px] font-medium text-primary hover:underline">{ligne.suite.libelle}</Link>
          )}
        </div>
        <Geste ligne={ligne} ouvrir={ouvrir} />
      </div>
      {plusieurs && deplie && (
        <ul id={idDetail} className="mt-2 border-l-2 border-border pl-3">
          {ligne.sousLignes.map((s) => (
            <li key={s.key} className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">{s.titre}</p>
                {s.sousTitre && <p className="truncate text-xs text-muted-foreground" title={s.sousTitre}>{s.sousTitre}</p>}
              </div>
              <Link href={s.geste.href} className={cn(bouton, contour, "h-10 px-3 text-xs sm:h-9")}>{s.geste.libelle}</Link>
            </li>
          ))}
          {ligne.suite && (
            <li className="py-2">
              <Link href={ligne.suite.href} className="text-[13px] font-medium text-primary hover:underline">{ligne.suite.libelle}</Link>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function Groupe({ g, ouvrir, ancre }: { g: GroupeAFaire; ouvrir: ((p: Panneau) => void) | null; ancre: string | null }) {
  const [deplie, setDeplie] = React.useState(!g.replie);
  if (g.lignes.length === 0) return null;
  const retard = g.cle === "retard";
  return (
    <>
      <h3 className={cn(
        "border-t border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide sm:px-5",
        retard ? "bg-destructive/10 text-destructive" : "bg-secondary/60 text-muted-foreground",
      )}>
        {g.libelle}{g.n > 0 ? ` · ${g.n}` : ""}
      </h3>
      {deplie ? (
        <ul>{g.lignes.map((l) => <Ligne key={l.key} ligne={l} ouvrir={ouvrir} ancre={l.key === ancre} />)}</ul>
      ) : (
        <div className="border-t border-border px-4 py-3 sm:px-5">
          <button type="button" onClick={() => setDeplie(true)} className="inline-flex min-h-10 items-center text-sm font-semibold text-primary hover:underline focus-ring">
            {libelleDeplier(g.n)}
          </button>
        </div>
      )}
    </>
  );
}

export function FileAFaire({ aFaire, conges, maintenant, currentUserId }: {
  aFaire: AFaire;
  /** Les congés à signer, tels que le centre les a lus — le panneau de décision les reprend. */
  conges: PendingLeave[];
  maintenant: string;
  currentUserId: string;
}) {
  const [panneau, setPanneau] = React.useState<Panneau>(null);
  const congeOuvert = panneau?.type === "conge" ? conges.find((c) => c.id === panneau.id) ?? null : null;
  const visibles = panneau?.type === "conges" ? conges : congeOuvert ? [congeOuvert] : [];
  const lignes = aFaire.groupes.flatMap((g) => g.lignes);
  // L'ancre `#conges-a-signer` se pose sur la première ligne de congé (une ancre qu'aucun élément ne porte ferait arriver en haut de page).
  const ancre = lignes.find((l) => l.panneau)?.key ?? null;

  // Une notification « Congé à signer » arrive avec `#conges-a-signer` : le panneau des congés s'ouvre de lui-même.
  React.useEffect(() => {
    const lire = () => { if (window.location.hash === `#${ANCRE_CONGES}` && conges.length > 0) setPanneau({ type: "conges" }); };
    lire();
    window.addEventListener("hashchange", lire);
    return () => window.removeEventListener("hashchange", lire);
  }, [conges.length]);
  // Décidé (le serveur a rafraîchi la liste) : le panneau d'un congé qui n'attend plus se referme.
  React.useEffect(() => {
    if ((panneau?.type === "conge" && !congeOuvert) || (panneau?.type === "conges" && conges.length === 0)) setPanneau(null);
  }, [panneau, congeOuvert, conges.length]);

  const fermer = React.useCallback(() => setPanneau(null), []);
  const ouvrir = conges.length > 0 ? setPanneau : null;

  return (
    <section aria-labelledby="a-faire-titre" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-3 pt-4 sm:px-5">
        <h2 id="a-faire-titre" className="text-[17px] font-semibold">
          À faire{aFaire.total > 0 && <span className="font-medium text-muted-foreground"> · {aFaire.total}</span>}
        </h2>
        {lignes.length > 0 && <span className="text-[13px] text-muted-foreground">Le plus urgent en premier</span>}
      </div>
      {lignes.length === 0 ? (
        <div className="border-t border-border px-4 py-8 text-center text-sm text-muted-foreground">
          <p className="text-base font-semibold text-success">Rien ne vous attend ici.</p>
          Aucun élément n&apos;attend un geste de votre part.
        </div>
      ) : (
        aFaire.groupes.map((g) => <Groupe key={g.cle} g={g} ouvrir={ouvrir} ancre={ancre} />)
      )}
      {/* « Missions terrain » n'est plus un onglet : ses invitations et ordres à valider sont des lignes de la file ; la page reste à un clic. */}
      <div className="border-t border-border px-4 py-3 sm:px-5">
        <Link href={CHEMIN_MES_MISSIONS} className="text-[13px] font-medium text-primary hover:underline">Missions terrain</Link>
      </div>

      <Sheet
        open={visibles.length > 0}
        onClose={fermer}
        width="xl"
        title={congeOuvert ? `Congé de ${congeOuvert.employee}` : `Congés à signer (${conges.length})`}
        description="Circuit responsable (N+1) → ressources humaines → direction générale. Approuver fait monter d'une marche ; refuser arrête le circuit."
      >
        <LeaveApprovals leaves={visibles} maintenant={maintenant} currentUserId={currentUserId} />
      </Sheet>
    </section>
  );
}
