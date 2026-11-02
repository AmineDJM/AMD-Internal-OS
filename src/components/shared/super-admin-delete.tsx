"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, AlertTriangle, Undo2 } from "lucide-react";
import { superAdminDelete, apercuDeSuppression } from "@/lib/actions/admin-delete-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * Bouton « Supprimer définitivement » réservé au Super Admin (n'est rendu que si `enabled`) :
 * ouvre une confirmation claire, supprime, puis redirige vers la liste où l'élément a disparu.
 * Le serveur revérifie le rôle — ce bouton n'est qu'une commodité.
 *
 * LA PHRASE DE LA CONFIRMATION DISAIT LE CONTRAIRE DU CODE. Elle annonçait « cette action ne
 * peut pas être annulée » alors que la suppression dépose un instantané dans la corbeille
 * (Administration → Corbeille) d'où le Super Admin restaure. Deux vérités dans le même geste, et
 * celle que la personne LIT était la fausse (§118.5). La phrase dit maintenant ce qui est vrai.
 *
 * CE QUI PART AVEC L'ÉLÉMENT SE LIT AVANT LE CLIC (§118.53, §118.162). Supprimer un sponsoring
 * emporte sa déclaration d'information médicale, ses demandes au secrétariat, son circuit, ses
 * postes : la fenêtre le DIT, lu par le même inventaire que la suppression elle-même — deux
 * listes de « ce qui part » finiraient par dire deux choses. Et quand une branche porte un fait
 * qui a quitté l'ERP (règlement, signature, dépôt aux autorités, courrier inscrit), le refus
 * s'affiche AVANT le clic et le bouton ne s'arme pas : proposer un geste qu'on retire ensuite
 * est une fausse promesse (§118.83).
 *
 * `warning` reste la place de ce que la restauration NE rendra PAS : pour un groupe de
 * messagerie, la cascade emporte membres et messages, donc « restaurable » sans cette réserve
 * promettrait un retour qui n'aura pas lieu (§104.16). Elle vient du registre (`KindSpec.reserve`),
 * jamais d'une rédaction propre à l'écran.
 */
export function SuperAdminDeleteButton({
  kind,
  id,
  name,
  enabled,
  label = "Supprimer définitivement",
  warning,
  compact = false,
  stay = false,
}: {
  kind: string;
  id: string;
  name: string;
  enabled: boolean;
  label?: string;
  /** Ligne d'avertissement supplémentaire (ex. périmètre exact de la suppression). */
  warning?: string;
  /** Icône seule (rangée de tableau) — la confirmation, elle, reste identique. */
  compact?: boolean;
  /** Rester sur la page après suppression (ligne d'une liste qui se rafraîchit en place). */
  stay?: boolean;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);

  if (!enabled) return null;

  return (
    <>
      {compact ? (
        <button
          type="button" onClick={() => setOpen(true)} title={label}
          aria-label={label} className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : (
        <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
          <Trash2 className="h-4 w-4" /> {label}
        </Button>
      )}

      <ConfirmationSuppression
        open={open}
        onClose={() => setOpen(false)}
        kind={kind}
        id={id}
        name={name}
        warning={warning}
        reserveAuSuperAdmin
        executer={superAdminDelete}
        onSupprime={(r) => {
          setOpen(false);
          if (!stay) router.push(r.redirect ?? "/mon-espace");
          rafraichir();
        }}
      />
    </>
  );
}

type Apercu = Awaited<ReturnType<typeof apercuDeSuppression>>;
type ResultatSuppression = { ok: boolean; error?: string; redirect?: string };

/**
 * LA FENÊTRE DE CONFIRMATION — partagée par le bouton du Super Admin et par la suppression
 * d'un événement depuis sa fiche (droit « supprimer » du module Événements). Une seule fenêtre,
 * parce que deux fenêtres pour le même geste diraient deux choses sur ce qui part (§118.5) :
 * l'une des deux était un `window.confirm` qui annonçait « et ses inscriptions » et rien d'autre,
 * puis taisait le refus quand la suppression n'avait pas lieu.
 */
export function ConfirmationSuppression({
  open,
  onClose,
  kind,
  id,
  name,
  warning,
  reserveAuSuperAdmin = false,
  executer,
  apercuer = apercuDeSuppression,
  onSupprime,
}: {
  open: boolean;
  onClose: () => void;
  kind: string;
  id: string;
  name: string;
  warning?: string;
  /** Le geste n'est ouvert qu'au Super Admin — la description le dit. */
  reserveAuSuperAdmin?: boolean;
  /** L'action serveur qui supprime — elle revérifie le droit ET relit ce qui part. */
  executer: (fd: FormData) => Promise<ResultatSuppression>;
  /**
   * L'action qui LIT ce qui partira, quand ce n'est pas celle du Super Admin — la même porte que `executer` :
   * un aperçu plus large dirait à quelqu'un ce qui dépend d'une ligne qu'il ne peut pas toucher, un aperçu
   * plus étroit ne s'armerait pas devant une suppression que l'action accepte (§118.209).
   */
  apercuer?: (fd: FormData) => Promise<Apercu>;
  onSupprime: (r: ResultatSuppression) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [apercu, setApercu] = React.useState<Apercu | null>(null);
  const [lectureImpossible, setLectureImpossible] = React.useState(false);

  // L'aperçu se relit à CHAQUE ouverture : entre deux ouvertures, une déclaration a pu naître,
  // un paiement partir.
  React.useEffect(() => {
    if (!open) return;
    let vivant = true;
    setApercu(null); setLectureImpossible(false); setError(null); setBusy(false);
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("id", id);
    apercuer(fd)
      .then((a) => { if (vivant) setApercu(a); })
      .catch(() => { if (vivant) setLectureImpossible(true); });
    return () => { vivant = false; };
  }, [open, kind, id, apercuer]);

  const lu = apercu && !("erreur" in apercu) ? apercu : null;
  const erreurLecture = apercu && "erreur" in apercu ? apercu.erreur : null;
  const introuvable = lu !== null && lu.nom === null;
  const refus = lu?.refus ?? null;
  // Le bouton ne s'arme qu'une fois SU ce qui part — sauf si la lecture a échoué pour une raison
  // de transport : la suppression relit elle-même tout, et refuse ce qui l'interdit.
  const enLecture = apercu === null && !lectureImpossible;
  const armable = !busy && !enLecture && !refus && !introuvable && !erreurLecture;

  async function confirmer() {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("id", id);
    try {
      const r = await executer(fd);
      if (r.ok) {
        onSupprime(r);
      } else {
        setBusy(false);
        setError(r.error ?? "Suppression impossible.");
      }
    } catch {
      setBusy(false);
      setError(actionFailureMessage("THROWN"));
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      title="Supprimer définitivement"
      description={reserveAuSuperAdmin
        ? "Réservé au Super Admin (et au directeur des opérations pour ses modules) — réversible depuis la corbeille."
        : "Réversible : l'élément se restaure depuis la corbeille."}
    >
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Cette suppression retire l'élément de tous les écrans.</p>
            <p>
              L'élément, ses pièces jointes et ses commentaires n'apparaîtront plus nulle part. Un instantané est
              déposé dans Administration → Corbeille : le Super Admin peut restaurer, jusqu'à la destruction réelle.
              {lu && !lu.lot ? " Les lignes liées supprimées en cascade, elles, ne reviennent pas." : ""}
            </p>
            {warning && <p className="font-semibold">{warning}</p>}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
          <p className="text-xs text-muted-foreground">Élément à supprimer</p>
          <p className="break-words font-medium">{name}</p>
        </div>

        <CeQuiPartAvec enLecture={enLecture} lectureImpossible={lectureImpossible} apercu={lu} />

        {(refus || erreurLecture || introuvable) && (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {refus ?? erreurLecture ?? "Élément introuvable (déjà supprimé ?)."}
          </p>
        )}
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <BoutonDecisif variant="destructive" onClick={confirmer} disabled={!armable}>
            {busy || enLecture ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Oui, supprimer définitivement
          </BoutonDecisif>
        </div>
      </div>
    </Sheet>
  );
}

/** « Part aussi avec lui » — l'inventaire du lot, lu avant le clic. */
function CeQuiPartAvec({ enLecture, lectureImpossible, apercu }: {
  enLecture: boolean;
  lectureImpossible: boolean;
  apercu: Extract<Apercu, { lot: boolean }> | null;
}) {
  if (enLecture) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Lecture de ce qui en dépend…
      </p>
    );
  }
  if (lectureImpossible) {
    return (
      <p className="text-sm text-muted-foreground">
        Je n'ai pas pu lire ce qui en dépend. La suppression le relira elle-même, et refusera si un paiement, une
        signature ou un dépôt aux autorités l'interdit.
      </p>
    );
  }
  if (!apercu || !apercu.lot || apercu.nom === null) return null;
  if (apercu.emporte.length === 0 && apercu.detache.length === 0) {
    return <p className="text-sm text-muted-foreground">Rien d'autre n'en dépend : l'élément part seul.</p>;
  }
  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-2 text-sm">
      {apercu.emporte.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Part aussi avec lui</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {apercu.emporte.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}
      {/* CE QUI RESTE mais perd son lien — un projet supprimé déclasse ses dossiers (§118.163). */}
      {apercu.detache.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Reste, mais perd son lien avec lui</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {apercu.detache.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Undo2 className="h-3.5 w-3.5" /> Tout cela revient avec lui si le Super Admin le restaure.
      </p>
    </div>
  );
}
