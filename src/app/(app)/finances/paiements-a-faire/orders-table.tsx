"use client";

import * as React from "react";
import Link from "next/link";
import { useFormAction } from "@/components/shared/use-action";
import { Loader2, RotateCcw, Banknote, MoreHorizontal } from "lucide-react";
import { resumeExpenseOrder } from "@/modules/finances/actions-depenses";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { PayerPanneau } from "./payer";
import { PanneauLigne, DetailPaiement } from "./panneau-ligne";
import { ReporterPanneau } from "./reporter";

/** Une pièce montrée au panneau de la ligne. */
export interface PieceLigne {
  documentId: string;
  nom: string;
  mime: string | null;
  nature: string;
}

/** Ce que le panneau d'une ligne montre : le justificatif, le RIB, le fil du dossier (`chargerDossiersDesLignes`). */
export interface PanneauDonnees {
  dossierId: string | null;
  demandeur: string | null;
  justificatif: PieceLigne | null;
  autresPieces: PieceLigne[];
  fil: { id: string; auteur: string; at: string; genre: string; message: string | null; deFinances: boolean }[];
  rib: string | null;
}

/** Le paiement fait (onglet « Payés ») : d'où, quand, comment — lu sur l'écriture de trésorerie. */
export interface PaiementFait {
  le: string | null;
  depuis: string | null;
  mode: string | null;
  reference: string | null;
}

/** UNE LIGNE DE « BANQUE & PAIEMENTS » — ce que l'écran affiche d'un ordre de dépense. */
export interface LigneBanque {
  id: string;
  reference: string;
  /** Le bénéficiaire, ou à défaut le libellé : c'est le nom qu'on cherche des yeux. */
  beneficiaire: string;
  /** L'objet du paiement (libellé · poste). */
  objet: string;
  /** « Facture — F-0912.pdf », ou « sans justificatif ». */
  justification: string;
  /** « Marketing 2026 · Congrès », « pas de budget (remise de caisse) », « à classer au paiement ». */
  budget: string;
  montant: number;
  status: string;
  /** Ce qui se lit dans la colonne d'échéance : « avant le … », « Fixe : … », « reporté au … », « depuis <compte> ». */
  echeance: string | null;
  /** Rouge SEULEMENT pour une échéance fixe : le reste est un repère. */
  echeanceFixe: boolean;
  dueDate: string | null;
  deadlineNature: string | null;
  deferredUntil: string | null;
  deferredReason: string | null;
  /** Les alertes à lire avant de payer (doublon possible, facture manquante) — une ligne seulement s'il y en a. */
  alertes: string[];
  /** « Relancé n fois par le demandeur — dernière relance le … », ou rien. */
  relances: string | null;
  question: "EN_ATTENTE_DEMANDEUR" | "REPONSE_RECUE" | null;
  /** « Payé le … » ou « Annulé » — pour l'onglet « Payés ». */
  historique: string | null;
  paiement: PaiementFait | null;
  /** Une remise de caisse d'avance : espèces, jamais de budget. */
  remise: boolean;
  needsBudget: boolean;
  compteParDefautId: string | null;
  bv: { nature: string; quittanceJointe: boolean } | null;
  dossierHref: string | null;
  panneau: PanneauDonnees;
}

/** Un compte d'où peut partir le règlement — avec son solde, dit au moment de choisir. */
export interface CompteChoice {
  id: string;
  nom: string;
  solde: number;
  jourAncrage: string;
}

/** Les catégories budgétaires où classer — chargées une fois pour toute la liste. */
export interface BudgetChoice {
  id: string;
  label: string;
}

/** LEVER LE REPORT — le retour à « À payer », pas un quatrième geste. */
function LeverReport({ id, beneficiaire, menu = false }: { id: string; beneficiaire: string; menu?: boolean }) {
  const { action, busy } = useFormAction(resumeExpenseOrder, {
    prepare: (fd) => fd.set("id", id), signalerErreurs: true, succes: `Report levé : ${beneficiaire} revient dans « À payer ».`,
  });
  return (
    <form action={action}>
      <Button type="submit" variant={menu ? "ghost" : "outline"} className={menu ? "w-full justify-start" : "h-10 sm:h-9"} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Lever le report
      </Button>
    </form>
  );
}

const ETAT_QUESTION = {
  EN_ATTENTE_DEMANDEUR: { label: "En attente du demandeur", tone: "warning" as const },
  REPONSE_RECUE: { label: "Réponse reçue", tone: "info" as const },
};

type Panneau = "voir" | "payer" | "reporter" | "detail" | null;

/** « ⋯ » d'une ligne — la liste de la maquette : payer, reporter, lever, voir, ouvrir le dossier. */
function MenuLigne({ ligne, canSettle, ouvrir }: { ligne: LigneBanque; canSettle: boolean; ouvrir: (p: Panneau) => void }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const ailleurs = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("touchstart", ailleurs);
    document.addEventListener("keydown", echap);
    return () => { document.removeEventListener("mousedown", ailleurs); document.removeEventListener("touchstart", ailleurs); document.removeEventListener("keydown", echap); };
  }, [open]);
  const choisir = (p: Panneau) => { setOpen(false); ouvrir(p); };
  const aPayer = ligne.status === "PENDING" && !ligne.deferredUntil;
  const reporte = ligne.status === "PENDING" && Boolean(ligne.deferredUntil);
  const item = "w-full justify-start";
  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={`Autres actions sur ${ligne.beneficiaire}`}
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground sm:h-9 sm:w-9"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" aria-label="Actions sur la ligne" className="absolute right-0 z-40 mt-1 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-0.5 rounded-lg border border-border bg-background p-1.5 shadow-lg">
          {aPayer && canSettle && <Button role="menuitem" variant="ghost" className={item} onClick={() => choisir("payer")}>Payer</Button>}
          {ligne.status === "PENDING" && canSettle && <Button role="menuitem" variant="ghost" className={item} onClick={() => choisir("reporter")}>{reporte ? "Changer la date du report" : "Reporter"}</Button>}
          {reporte && canSettle && <LeverReport id={ligne.id} beneficiaire={ligne.beneficiaire} menu />}
          {ligne.status !== "PENDING" && <Button role="menuitem" variant="ghost" className={item} onClick={() => choisir("detail")}>{ligne.status === "CANCELLED" ? "Voir l'ordre annulé" : "Voir le paiement"}</Button>}
          <Button role="menuitem" variant="ghost" className={item} onClick={() => choisir("voir")}>Voir le justificatif et les échanges</Button>
          {ligne.dossierHref && <Link role="menuitem" href={ligne.dossierHref} className="flex min-h-10 items-center rounded-md px-4 text-sm font-medium hover:bg-secondary">Ouvrir le dossier</Link>}
        </div>
      )}
    </div>
  );
}

function Ligne({ ligne, canSettle, enAvant, comptes, budgets }: { ligne: LigneBanque; canSettle: boolean; enAvant: boolean; comptes: CompteChoice[]; budgets: BudgetChoice[] }) {
  const [ouvert, setOuvert] = React.useState<Panneau>(null);
  const fermer = React.useCallback(() => setOuvert(null), []);
  const paye = ligne.status !== "PENDING";
  const reporte = !paye && Boolean(ligne.deferredUntil);
  const voir = () => setOuvert(paye ? "detail" : "voir");
  const question = !paye && ligne.question ? ETAT_QUESTION[ligne.question] : null;
  return (
    <li
      id={`ord-${ligne.id}`} data-ordre={ligne.id}
      className={`scroll-mt-24 px-3 py-4 sm:px-5 ${enAvant || ouvert ? "bg-primary/5 shadow-[inset_3px_0_0_hsl(var(--primary))]" : ""} ${enAvant ? "outline outline-2 -outline-offset-2 outline-primary/40" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_18rem]">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={voir} className="min-w-0 text-left font-semibold text-primary hover:underline [overflow-wrap:anywhere]">
              {ligne.beneficiaire}
            </button>
            {question && <Badge tone={question.tone} dot={false}>{question.label}</Badge>}
          </div>
          <p className="text-sm [overflow-wrap:anywhere]">{ligne.objet}</p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Justificatif : <button type="button" onClick={voir} className="text-primary hover:underline">{ligne.justification}</button> · {ligne.budget}
          </p>
          {!paye && ligne.relances && <p className="mt-1 text-xs font-medium text-warning" data-relances>{ligne.relances}</p>}
          {!paye && ligne.alertes.map((a) => <p key={a} className="mt-1 text-xs font-semibold text-warning [overflow-wrap:anywhere]" data-alerte>{a}</p>)}
        </div>
        {ligne.echeance && (
          <span className={`shrink-0 whitespace-nowrap text-sm ${ligne.echeanceFixe ? "font-bold text-destructive" : reporte ? "font-semibold text-warning" : "text-muted-foreground"}`}>{ligne.echeance}</span>
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap text-right text-base font-semibold tabular-nums sm:w-36">{formatCurrency(ligne.montant)}</span>
        <div className="flex shrink-0 items-center gap-2">
          {!paye && !reporte && canSettle && (
            <Button type="button" className="h-10 sm:h-9" onClick={() => setOuvert("payer")}><Banknote className="h-4 w-4" /> Payer</Button>
          )}
          {reporte && canSettle && <LeverReport id={ligne.id} beneficiaire={ligne.beneficiaire} />}
          {paye && ligne.historique && (
            <button
              type="button" onClick={() => setOuvert("detail")}
              className={`h-8 whitespace-nowrap rounded-full px-3 text-sm font-semibold ${ligne.status === "CANCELLED" ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"}`}
            >
              {ligne.historique}
            </button>
          )}
          <MenuLigne ligne={ligne} canSettle={canSettle} ouvrir={setOuvert} />
        </div>
      </div>
      {ouvert === "voir" && <PanneauLigne ligne={ligne} onClose={fermer} canSettle={canSettle} onPayer={() => setOuvert("payer")} />}
      {ouvert === "detail" && <DetailPaiement ligne={ligne} onClose={fermer} />}
      {ouvert === "payer" && <PayerPanneau ligne={ligne} comptes={comptes} budgets={budgets} onClose={fermer} />}
      {ouvert === "reporter" && <ReporterPanneau ligne={ligne} onClose={fermer} />}
    </li>
  );
}

/**
 * LA LISTE DE « BANQUE & PAIEMENTS » — une ligne par ordre, UN geste visible (« Payer », « Lever le report », ou
 * l'état « Payé le … » / « Annulé »), le reste dans « ⋯ ». Cliquer le bénéficiaire ou le justificatif ouvre DIRECTEMENT
 * le justificatif, le RIB et les échanges avec le demandeur.
 *
 * Les Finances ne peuvent ni annuler ni réviser : l'ordre leur arrive AUTORISÉ par le centre. `focusId` — LA LIGNE QU'ON
 * VIENT DE CLIQUER depuis « Mon espace » (plusieurs identifiants séparés par des virgules), mise en évidence et
 * atteignable par l'ancre `#ord-<id>`.
 */
export function OrdersTable({ lignes, canSettle, vide, pied, focusId = null, budgets = [], comptes = [] }: {
  lignes: LigneBanque[];
  canSettle: boolean;
  vide: string;
  pied: string;
  focusId?: string | null;
  budgets?: BudgetChoice[];
  comptes?: CompteChoice[];
}) {
  const enAvant = new Set((focusId ?? "").split(",").filter(Boolean));
  return (
    <section aria-label="Liste" className="space-y-2">
      {lignes.length === 0 ? (
        <EmptyState icon="ReceiptText" title={vide} description="Les paiements autorisés par le centre de paiement arrivent ici." />
      ) : (
        <ul className="surface divide-y divide-border">
          {lignes.map((l) => <Ligne key={l.id} ligne={l} canSettle={canSettle} enAvant={enAvant.has(l.id)} comptes={comptes} budgets={budgets} />)}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{pied}</p>
    </section>
  );
}
