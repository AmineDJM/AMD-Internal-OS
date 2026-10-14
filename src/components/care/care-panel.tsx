"use client";

import * as React from "react";
import {
  Plus, Loader2, CheckCircle2, XCircle, UserPlus, Receipt, AlertTriangle, Send, FileText, ExternalLink, Users, Trash2,
} from "lucide-react";
import type { CareCellStatus, CareMode, CareServiceKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { formatCurrency } from "@/lib/utils";
import {
  careProgress, financeReadiness, piecesDuProfessionnel, ETAT_PIECE_LABELS, CELL_STATUS_LABELS, QUOTE_STATUS_LABELS, SERVICE_KIND_LABELS,
} from "@/lib/care";
import {
  depassementEnveloppe, deviseDuPoste, etatBilletterie, etatHotellerie, montantLisible, montantPosteGroupe, personneVivante,
  personnePasseport, pucesAutresPostes, resumeDesFiches, versDzd, MODE_LIBELLE, TYPES_POSTE,
  type BeneficiaryRow, type GroupPosteRow, type Perimetre, type QuoteRow,
} from "@/lib/care-fiches";
import {
  addCareBeneficiary, createCareQuote, decideCareQuote, requestCareQuotes, sendCareToFinance,
  demanderPiecesPriseEnCharge, deposerPiecePriseEnCharge, setCareCellStatus,
  demanderBCPriseEnCharge, ajouterPosteGroupe, modifierPosteGroupe, retirerPosteGroupe,
  retenirDevisPriseEnCharge,
} from "@/lib/actions/care-actions";
import { listBeneficiaryRefs } from "@/lib/actions/congress-beneficiary-actions";
import { filtrerAnnuaire, PLAFOND_MENU } from "@/components/care/filtrer-annuaire";
import { CHAMP, FicheVoyageur, PastilleDecision, TON_BADGE, type Run } from "@/components/care/fiche-voyageur";
import { BandeauEnvois } from "@/components/reservation-fiche/envoi-fiche";
import type { EnvoiVue } from "@/lib/reservation-fiche/etat";

export type { CellRow, BeneficiaryRow, QuoteRow } from "@/lib/care-fiches";

interface Props {
  scope: Perimetre;
  requestId: string;
  beneficiaries: BeneficiaryRow[];
  quotes: QuoteRow[];
  groupPostes: GroupPosteRow[];
  /** Le mode, le taux figé, le sujet de l'assistante de direction, la ville de l'événement. */
  reglages: { mode: CareMode; taux: number | null; reservation: { id: string; reference: string } | null; city: string | null };
  /** L'enveloppe accordée par la Direction — `null` tant qu'elle n'a pas tranché. */
  enveloppe: number | null;
  directory: { id: string; name: string; specialty: string | null; institution: string | null }[];
  /** La Direction a-t-elle validé l'événement ? Conditionne la demande de devis au secrétariat. */
  eventApproved: boolean;
  canEdit: boolean;
  /** Trancher : accorder une personne, accepter un devis, envoyer aux Finances. */
  canDecide: boolean;
  /** Déposer le billet émis et la confirmation d'hôtel (`peutTeleverserBillet`) — et éditer les livrets de séjour. */
  peutTeleverser: boolean;
  /** Les supports promotionnels rattachables à un poste (`carePromoOptions`). */
  promoOptions?: { id: string; reference: string; title: string }[];
  /** L'état de chaque billet / hôtel chez l'assistante de direction (`EnvoiVue`, par case) — chaque fiche s'envoie seule (14/10). */
  envois?: Record<string, EnvoiVue>;
}

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

/**
 * PRISE EN CHARGE — « Professionnels pris en charge » : UNE LIGNE PAR PERSONNE, et sa fiche voyageur
 * (Direction, 10/2026). La liste reste un tableau au téléphone (il défile, la colonne du nom reste fixe).
 *
 * Le bandeau des chiffres est celui de la carte de la demande ; ici, la liste, les gestes de la demande
 * (ajouter un professionnel, demander la réservation, demander le BC), les prix du groupe en mode « de groupe »,
 * les devis, les pièces et le passage aux Finances. Les règles vivent dans `lib/care-fiches.ts`.
 */
export function CarePanel({
  scope, requestId, beneficiaries, quotes, groupPostes, reglages, enveloppe, directory, eventApproved, canEdit, canDecide, peutTeleverser, promoOptions = [],
  envois = {},
}: Props) {
  const { enCours, rafraichir } = useRafraichir();
  const [action, setAction] = React.useState<string | null>(null);
  const busy = action ?? (enCours ? "rafraichir" : null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [quoting, setQuoting] = React.useState<{ cellIds: string[] } | null>(null);
  const [ficheId, setFicheId] = React.useState<string | null>(null);
  const lock = React.useRef(false);
  const devisRef = React.useRef<HTMLElement>(null);

  const run: Run = async (key, fn, okText) => {
    if (lock.current) return { ok: false };
    lock.current = true;
    setAction(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? okText ?? "Terminé.") : (r.error ?? "Échec.") });
      if (r.ok) rafraichir();
      return r;
    } finally {
      setAction(null);
      lock.current = false;
    }
  };

  const mode = reglages.mode;
  const resume = resumeDesFiches(scope, beneficiaries, quotes, groupPostes);
  const est = resume.estimations;
  const depasse = depassementEnveloppe(est.total, enveloppe);
  const retenusEnAttente = quotes.filter((q) => q.status === "PENDING" && q.retained && !q.bcRequested);
  const fiche = ficheId ? beneficiaries.find((b) => b.id === ficheId) ?? null : null;
  const personnes = beneficiaries.map((b) => ({ id: b.id, status: b.status }));

  const ouvrirDevis = (cellIds: string[]) => {
    setFicheId(null);
    setQuoting({ cellIds });
    window.setTimeout(() => devisRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const qLike = quotes.map((q) => ({ id: q.id, status: q.status, amountDzd: q.amountDzd, cellIds: q.cellIds }));
  const readiness = financeReadiness(
    beneficiaries.map((b) => ({ status: b.status, name: b.name, progress: careProgress(b.cells) })),
    qLike,
  );
  // Les éléments à acheter des personnes ACCORDÉES encore sans devis — ce qu'on envoie chiffrer au secrétariat.
  const toQuote = beneficiaries.filter((b) => b.status === "APPROVED").flatMap((b) => b.cells.filter((c) => c.kind === "SERVICE" && c.status === "REQUESTED"));

  return (
    <div className="space-y-4" id="professionnels">
      {msg && (
        <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="min-w-0 [overflow-wrap:anywhere]">{msg.text}</span>
        </p>
      )}
      {depasse && <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {depasse}</p>}

      {fiche ? (
        <FicheVoyageur
          scope={scope} requestId={requestId} mode={mode} b={fiche} quotes={quotes} groupPostes={groupPostes} personnes={personnes}
          taux={reglages.taux} eventCity={reglages.city} parCase={est.parCase} estime={est.parPersonne.get(fiche.id) ?? 0}
          canEdit={canEdit} canDecide={canDecide} peutTeleverser={peutTeleverser} busy={busy} run={run} promoOptions={promoOptions} envois={envois}
          onRetour={() => setFicheId(null)} onDevis={ouvrirDevis}
        />
      ) : (
        <section className="rounded-xl border border-border bg-card">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Professionnels pris en charge</h3>
              <Badge tone={mode === "GROUP" ? "purple" : "neutral"} dot={false}>{MODE_LIBELLE[mode]}</Badge>
              <InfoBulle label="Le mode de prise en charge">
                {mode === "GROUP"
                  ? "De groupe : un devis par catégorie couvre tout le monde, et un poste « par personne » s'applique à chacun. Les fiches gardent l'identité, le trajet, les dates et la chambre de chaque personne."
                  : "Individuelle : chaque fiche a ses postes et ses devis. Le mode se change en corrigeant la demande."}
                {scope === "INTERNATIONAL" && ` Tout sauf la billetterie se saisit en dollars (1 USD = ${reglages.taux ?? "?"} DZD, taux figé sur la demande).`}
              </InfoBulle>
              {reglages.reservation && (
                <a href={`/dossiers/${reglages.reservation.id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  sujet {reglages.reservation.reference} <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {peutTeleverser && beneficiaries.length > 0 && (
                <a href={`${scope === "NATIONAL" ? "/congress-national" : "/congress-international"}/${requestId}/billets`} className="text-xs text-primary hover:underline">
                  billets et confirmations
                </a>
              )}
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                {retenusEnAttente.length > 0 && (
                  <Button size="sm" variant="outline" disabled={busy !== null}
                    onClick={() => void run("bc", () => demanderBCPriseEnCharge(undefined, fd({ scope, requestId })))}>
                    {busy === "bc" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Demander le BC ({retenusEnAttente.length})
                  </Button>
                )}
                <Button size="sm" disabled={busy !== null} onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" /> Ajouter un professionnel</Button>
              </div>
            )}
          </header>

          {/* LES FICHES CHEZ L'ASSISTANTE (14/10) : chaque billet, chaque hôtel part seul — ici le bilan et le raccourci. */}
          {Object.keys(envois).length > 0 && (
            <div className="border-b border-border px-4 py-2">
              <BandeauEnvois envois={Object.values(envois)} lot={{ scope, requestId }} peutEditer={canEdit} busy={busy} run={run} />
            </div>
          )}

          {adding && canEdit && (
            <div className="border-b border-border p-3">
              <AddBeneficiaryForm
                scope={scope} requestId={requestId} directory={directory} busy={busy === "add"}
                onCancel={() => setAdding(false)}
                onSubmit={(f) => void run("add", async () => {
                  const r = await addCareBeneficiary(undefined, f);
                  if (r.ok) { setAdding(false); if (r.id) setFicheId(r.id); }
                  return r;
                }, "Professionnel ajouté — sa fiche est ouverte.")}
              />
            </div>
          )}

          {beneficiaries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Aucun professionnel pour l&apos;instant — ajoutez-les depuis l&apos;annuaire ou en profil libre.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-sm tabular-nums">
                <thead>
                  <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
                    <th className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium">Professionnel</th>
                    <th className="px-3 py-2 font-medium">Billetterie</th>
                    <th className="px-3 py-2 font-medium">Hôtellerie</th>
                    <th className="px-3 py-2 font-medium">Autres postes</th>
                    <th className="px-3 py-2 text-right font-medium">Estimé</th>
                    <th className="px-3 py-2 font-medium">Décision</th>
                    <th className="px-3 py-2"><span className="sr-only">Fiche</span></th>
                  </tr>
                </thead>
                <tbody>
                  {beneficiaries.map((b) => {
                    const billet = etatBilletterie(scope, b.name, b.cells, personnePasseport(b.cells), quotes);
                    const hotel = etatHotellerie(b.cells, quotes);
                    const puces = pucesAutresPostes(b.cells);
                    const vivant = personneVivante(b.status);
                    return (
                      <tr key={b.id} className={`border-t border-border ${vivant ? "" : "text-muted-foreground"}`}>
                        <td className="sticky left-0 z-[1] max-w-[220px] bg-card px-3 py-2.5">
                          <span className="block font-medium [overflow-wrap:anywhere]">{b.name}</span>
                          <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{[b.subtitle, b.fromDirectory ? null : "profil libre"].filter(Boolean).join(" · ")}</span>
                        </td>
                        <td className="px-3 py-2.5"><Badge tone={TON_BADGE[billet.ton]} dot={false}>{billet.libelle}</Badge></td>
                        <td className="px-3 py-2.5"><Badge tone={TON_BADGE[hotel.ton]} dot={false}>{hotel.libelle}</Badge></td>
                        <td className="px-3 py-2.5">
                          {puces.length === 0 ? <span className="text-muted-foreground">—</span> : (
                            <span className="flex flex-wrap gap-1">{puces.map((x) => <Badge key={x} tone="neutral" dot={false}>{x}</Badge>)}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right">{formatCurrency(est.parPersonne.get(b.id) ?? 0)}</td>
                        <td className="px-3 py-2.5"><PastilleDecision status={b.status} /></td>
                        <td className="px-3 py-2.5 text-right">
                          <Button size="sm" variant="outline" disabled={enCours} onClick={() => setFicheId(b.id)}>Ouvrir la fiche</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-semibold">
                    <td className="sticky left-0 z-[1] bg-card px-3 py-2.5">Total</td>
                    <td colSpan={3} className="px-3 py-2.5 text-xs font-normal text-muted-foreground">
                      Inclus : {resume.billets} billet{resume.billets > 1 ? "s" : ""} · {resume.nuits} nuit{resume.nuits > 1 ? "s" : ""} · {resume.autres} autre{resume.autres > 1 ? "s" : ""} poste{resume.autres > 1 ? "s" : ""}
                      {est.groupe > 0 ? ` · postes de groupe ${formatCurrency(est.groupe)}` : ""}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">{formatCurrency(est.total)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── Les prix du groupe ── */}
      {(mode === "GROUP" || groupPostes.length > 0) && (
        <PrixDuGroupe
          scope={scope} requestId={requestId} postes={groupPostes} personnes={personnes} taux={reglages.taux}
          canEdit={canEdit} busy={busy} run={run} onDevis={() => ouvrirDevis([])}
        />
      )}

      {/* ── Devis ── */}
      <section ref={devisRef} className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Receipt className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Devis</h3>
          {retenusEnAttente.length > 0 && <Badge tone="info" dot={false}>{retenusEnAttente.length} retenu{retenusEnAttente.length > 1 ? "s" : ""}</Badge>}
          {canEdit && !quoting && (
            <Button size="sm" variant="outline" className="ml-auto" disabled={busy !== null || beneficiaries.length === 0} onClick={() => setQuoting({ cellIds: [] })}>
              <Plus className="h-4 w-4" /> Enregistrer un devis reçu
            </Button>
          )}
        </div>
        {canEdit && toQuote.length > 0 && (
          <Button
            size="sm" variant="outline" disabled={busy !== null || !eventApproved}
            title={eventApproved ? undefined : "La Direction n'a pas encore validé l'événement."}
            onClick={() => void run("rq", () => requestCareQuotes(undefined, fd({ scope, requestId })))}
          >
            {busy === "rq" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Demander les devis au secrétariat ({toQuote.length})
          </Button>
        )}
        {quoting && canEdit && (
          <QuoteForm
            scope={scope} requestId={requestId} mode={mode} taux={reglages.taux} beneficiaries={beneficiaries} preselection={quoting.cellIds}
            busy={busy === "nq"} onCancel={() => setQuoting(null)}
            onSubmit={(f) => void run("nq", async () => {
              const r = await createCareQuote(undefined, f);
              if (r.ok) setQuoting(null);
              return r;
            }, "Devis enregistré.")}
          />
        )}
        {quotes.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun devis pour l&apos;instant.</p>
        ) : (
          <ul className="divide-y divide-border">
            {quotes.map((q) => (
              <li key={q.id} className="space-y-1 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {q.documentId
                    ? <a href={`/api/documents/${q.documentId}`} target="_blank" rel="noreferrer" className="min-w-0 font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere]">{q.supplier}</a>
                    : <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{q.supplier}</span>}
                  {q.reference && <span className="min-w-0 font-mono text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">{q.reference}</span>}
                  {q.serviceKind && <Badge tone="neutral" dot={false}>{SERVICE_KIND_LABELS[q.serviceKind]}</Badge>}
                  <span className="tabular-nums">{q.amount != null && q.currency === "USD" ? `${montantLisible(q.amount, "USD")} = ${formatCurrency(q.amountDzd)}` : formatCurrency(q.amountDzd)}</span>
                  <Badge tone={q.status === "ACCEPTED" ? "success" : q.status === "REJECTED" ? "danger" : q.retained ? "success" : "warning"} dot={false}>
                    {q.status === "PENDING" && q.retained ? (q.bcRequested ? "retenu · BC demandé" : "retenu") : QUOTE_STATUS_LABELS[q.status]}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">Couvre : {q.cellLabels.length ? `${q.cellIds.length} poste${q.cellIds.length > 1 ? "s" : ""} (${[...new Set(q.cellLabels)].join(", ")})` : "—"}</p>
                {q.note && <p className="text-xs italic text-muted-foreground">{q.note}</p>}
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {canEdit && q.status === "PENDING" && !q.bcRequested && (
                    <Button size="sm" variant="outline" disabled={busy !== null}
                      onClick={() => void run(`ret:${q.id}`, () => retenirDevisPriseEnCharge(undefined, fd(q.retained ? { id: q.id, annuler: "on" } : { id: q.id })))}>
                      {q.retained ? "Ne plus retenir" : "Retenir"}
                    </Button>
                  )}
                  {canDecide && q.status === "PENDING" && (["ACCEPTED", "REJECTED"] as const).map((d) => (
                    <Button key={d} size="sm" variant={d === "ACCEPTED" ? "primary" : "outline"} disabled={busy !== null}
                      onClick={() => void run(`q:${q.id}`, () => decideCareQuote(undefined, fd({ id: q.id, decision: d })), d === "ACCEPTED" ? "Devis accepté — ordre de dépense émis." : "Devis refusé.")}>
                      {busy === `q:${q.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      {d === "ACCEPTED" ? "Accepter" : "Refuser"}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Les pièces de chaque professionnel ── */}
      <PiecesDesProfessionnels scope={scope} requestId={requestId} beneficiaries={beneficiaries} canEdit={canEdit} busy={busy} run={run} />

      {/* ── Finances ── */}
      {canDecide && beneficiaries.length > 0 && (
        <section className="space-y-2 border-t border-border pt-4">
          {!readiness.ready && (
            <div className="rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <AlertTriangle className="h-4 w-4 text-warning" /> Le dossier n&apos;est pas complet
              </p>
              <ul className="mt-1 space-y-0.5">
                {readiness.blockers.map((x, i) => <li key={i} className="text-xs text-muted-foreground">• {x}</li>)}
              </ul>
            </div>
          )}
          <Button size="sm" disabled={!readiness.ready || busy !== null}
            onClick={() => void run("fin", () => sendCareToFinance(undefined, fd({ scope, requestId })))}>
            {busy === "fin" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Transmettre aux Finances
          </Button>
        </section>
      )}
    </div>
  );
}

/**
 * LES PRIX DU GROUPE (mode « de groupe ») — les postes « par personne » (montant unitaire × personnes concernées,
 * une exclusion se fait sur la fiche) ; les devis par catégorie s'enregistrent dans « Devis », catégorie choisie.
 */
function PrixDuGroupe({ scope, requestId, postes, personnes, taux, canEdit, busy, run, onDevis }: {
  scope: Perimetre; requestId: string; postes: GroupPosteRow[]; personnes: { id: string; status: BeneficiaryRow["status"] }[];
  taux: number | null; canEdit: boolean; busy: string | null; run: Run; onDevis: () => void;
}) {
  const [ajout, setAjout] = React.useState(false);
  const [type, setType] = React.useState("DEJEUNER");
  const t = TYPES_POSTE.find((x) => x.cle === type) ?? TYPES_POSTE[0]!;
  const devise = deviseDuPoste(scope, t.serviceKind);
  const [unitaire, setUnitaire] = React.useState("");
  const n = Number(unitaire.replace(",", "."));
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Prix du groupe</h3>
        <InfoBulle label="Comment ça marche ?">Un devis par catégorie (billetterie, hôtellerie…) couvre les postes de tout le monde. Un poste « par personne » (ex. repas) s&apos;applique à chacun ; une personne s&apos;en exclut depuis sa fiche.</InfoBulle>
        {canEdit && (
          <span className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={onDevis}><FileText className="h-4 w-4" /> Devis de groupe</Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setAjout((v) => !v)}><Plus className="h-4 w-4" /> Poste par personne</Button>
          </span>
        )}
      </div>
      {ajout && canEdit && (
        <form
          className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-6 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            f.set("scope", scope);
            f.set("requestId", requestId);
            void run("gadd", async () => {
              const r = await ajouterPosteGroupe(undefined, f);
              if (r.ok) { setAjout(false); setUnitaire(""); }
              return r;
            });
          }}
        >
          <label className="block text-xs text-muted-foreground">Catégorie
            <select name="posteType" value={type} onChange={(e) => setType(e.target.value)} className={CHAMP}>
              {TYPES_POSTE.map((x) => <option key={x.cle} value={x.cle}>{x.libelle}</option>)}
            </select>
          </label>
          <label className="block text-xs text-muted-foreground sm:col-span-2">Libellé<input name="label" placeholder={t.libelle} className={CHAMP} /></label>
          <label className="block text-xs text-muted-foreground">Date<input name="date" type="date" className={CHAMP} /></label>
          <label className="block text-xs text-muted-foreground">Heure<input name="timeStart" type="time" className={CHAMP} /></label>
          <label className="block text-xs text-muted-foreground">Par personne ({devise})
            <input name="unitAmount" inputMode="decimal" value={unitaire} onChange={(e) => setUnitaire(e.target.value)} className={CHAMP} />
            {devise === "USD" && unitaire && Number.isFinite(n) && <span className="text-[0.6875rem] text-primary">≈ {formatCurrency(versDzd(n, "USD", taux) ?? 0)}</span>}
          </label>
          <label className="block text-xs text-muted-foreground sm:col-span-3">Lieu / adresse<input name="address" placeholder="Facultatif" className={CHAMP} /></label>
          <label className="block text-xs text-muted-foreground sm:col-span-3">Précisions<input name="notes" className={CHAMP} /></label>
          <div className="flex flex-wrap gap-2 sm:col-span-6">
            <Button type="submit" size="sm" disabled={busy !== null}>{busy === "gadd" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAjout(false)}>Annuler</Button>
          </div>
        </form>
      )}
      {postes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucun poste par personne.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm tabular-nums">
            <thead>
              <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium">Poste</th>
                <th className="px-3 py-2 font-medium">Quand, où</th>
                <th className="px-3 py-2 text-right font-medium">Par personne</th>
                <th className="px-3 py-2 text-right font-medium">Personnes</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">État</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {postes.map((g) => {
                const concernees = personnes.filter((x) => personneVivante(x.status) && !g.excludedBeneficiaryIds.includes(x.id)).length;
                const total = montantPosteGroupe(g, personnes);
                return (
                  <tr key={g.id} className="border-t border-border">
                    <td className="sticky left-0 z-[1] bg-card px-3 py-2"><span className="font-medium">{g.label}</span></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{[g.date?.split("-").reverse().join("/"), g.timeStart, g.address].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{g.unitAmount != null ? montantLisible(g.unitAmount, g.currency) : "—"}</td>
                    <td className="px-3 py-2 text-right">{concernees}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{total != null ? formatCurrency(total) : "—"}</td>
                    <td className="px-3 py-2">
                      {canEdit ? (
                        <select value={g.status} disabled={busy !== null} aria-label={`État de « ${g.label} »`}
                          onChange={(e) => void run(`gs:${g.id}`, () => modifierPosteGroupe(undefined, fd({ id: g.id, status: e.target.value })))}
                          className="min-h-9 rounded-lg border border-border bg-background px-1.5 py-1 text-base sm:min-h-0 sm:text-xs">
                          {(["REQUESTED", "PROVIDED", "SETTLED", "WAIVED"] as CareCellStatus[]).map((s) => <option key={s} value={s}>{CELL_STATUS_LABELS[s]}</option>)}
                        </select>
                      ) : <Badge tone="neutral" dot={false}>{CELL_STATUS_LABELS[g.status]}</Badge>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && g.status !== "SETTLED" && (
                        <button type="button" disabled={busy !== null} aria-label={`Retirer « ${g.label} »`}
                          onClick={() => { if (window.confirm(`Retirer le poste « ${g.label} » ?`)) void run(`gd:${g.id}`, () => retirerPosteGroupe(undefined, fd({ id: g.id }))); }}
                          className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:h-7 sm:w-7">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * AJOUTER UN PROFESSIONNEL — depuis l'annuaire (menu AVEC RECHERCHE), en créant son profil de médecin, ou en profil
 * libre. Les trois écrivent la MÊME ligne (`addCareBeneficiary`), qui naît avec sa billetterie et son hôtellerie.
 */
function AddBeneficiaryForm({ scope, requestId, directory, busy, onCancel, onSubmit }: {
  scope: string; requestId: string; directory: Props["directory"]; busy: boolean;
  onCancel: () => void; onSubmit: (f: FormData) => void;
}) {
  const [mode, setMode] = React.useState<"directory" | "new" | "free">("directory");
  const [q, setQ] = React.useState("");
  const [refs, setRefs] = React.useState<{ specialties: { id: string; name: string }[]; institutions: { id: string; name: string; wilaya: string | null }[] } | null>(null);
  React.useEffect(() => {
    if (mode !== "new" || refs) return;
    listBeneficiaryRefs().then((r) => setRefs({ specialties: r.specialties, institutions: r.institutions })).catch(() => setRefs({ specialties: [], institutions: [] }));
  }, [mode, refs]);
  const filtres = filtrerAnnuaire(directory, q);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }} className="space-y-2">
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="requestId" value={requestId} />
      {mode === "new" && <input type="hidden" name="createDoctor" value="on" />}

      <div className="flex flex-wrap gap-2">
        {(["directory", "new", "free"] as const).map((m) => (
          <button
            key={m} type="button" onClick={() => setMode(m)}
            className={`min-h-9 rounded-lg border px-2.5 py-1 text-xs transition sm:min-h-0 ${mode === m ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-secondary"}`}
          >
            {m === "directory" ? "Depuis l'annuaire" : m === "new" ? "Nouveau médecin" : "Profil libre"}
          </button>
        ))}
      </div>

      {mode === "directory" && (
        <div className="space-y-1.5">
          <label className="block text-xs">
            Rechercher un praticien
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, spécialité, établissement…" className={CHAMP} />
          </label>
          <label className="block text-xs">
            Praticien
            <select name="doctorId" required className={CHAMP}>
              <option value="">{filtres.length ? "Choisir…" : "Aucun praticien ne correspond"}</option>
              {filtres.map((d) => (
                <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` — ${d.specialty}` : ""}{d.institution ? ` (${d.institution})` : ""}</option>
              ))}
            </select>
          </label>
          {filtres.length >= PLAFOND_MENU && <p className="text-[0.6875rem] text-muted-foreground">Les {PLAFOND_MENU} premiers résultats seulement — précisez la recherche.</p>}
        </div>
      )}
      {mode === "new" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs sm:col-span-2">Nom du médecin<input name="doctorName" required placeholder="Dr …" className={CHAMP} /></label>
          <label className="text-xs">Spécialité
            <select name="specialtyId" defaultValue="" className={CHAMP}><option value="">—</option>{(refs?.specialties ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
          <label className="text-xs">Secteur
            <select name="sector" defaultValue="" className={CHAMP}><option value="">—</option><option value="HOSPITAL">Hospitalier</option><option value="LIBERAL">Libéral</option><option value="BOTH">Les deux</option></select>
          </label>
          <label className="text-xs sm:col-span-2">Établissement
            <select name="institutionId" defaultValue="" className={CHAMP}><option value="">—</option>{(refs?.institutions ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.wilaya ? ` · ${x.wilaya}` : ""}</option>)}</select>
          </label>
        </div>
      )}
      {mode === "free" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">Prénom<input name="firstName" className={CHAMP} /></label>
          <label className="text-xs">Nom<input name="lastName" required className={CHAMP} /></label>
          <label className="text-xs sm:col-span-2">Établissement<input name="institution" placeholder="CHU Mustapha…" className={CHAMP} /></label>
        </div>
      )}
      <label className="block text-xs">Qualité<input name="jobTitle" placeholder="Orateur, invité, chef de service…" className={CHAMP} /></label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" type="submit" className="w-full sm:w-auto" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {mode === "new" ? "Créer et ajouter" : "Ajouter"}
        </Button>
        <Button size="sm" type="button" variant="outline" className="w-full sm:w-auto" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/**
 * ENREGISTRER UN DEVIS REÇU — il couvre CE QU'IL COUVRE : en mode individuel, on coche les postes (éventuellement
 * de plusieurs fiches : un devis d'agence pour un groupe de billets) ; en mode « de groupe », on choisit la
 * catégorie et le devis couvre les postes de cette catégorie de tout le monde. Le montant se saisit dans la devise
 * des postes couverts (le dollar à l'international, sauf la billetterie).
 */
export function QuoteForm({ scope, requestId, mode, taux, beneficiaries, preselection, busy, onCancel, onSubmit }: {
  scope: Perimetre; requestId: string; mode: CareMode; taux: number | null; beneficiaries: BeneficiaryRow[]; preselection: string[];
  busy: boolean; onCancel: () => void; onSubmit: (f: FormData) => void;
}) {
  const [parCategorie, setParCategorie] = React.useState(mode === "GROUP" && preselection.length === 0);
  const [categorie, setCategorie] = React.useState<CareServiceKind>("TICKET");
  const [coches, setCoches] = React.useState<Set<string>>(new Set(preselection));
  const [montant, setMontant] = React.useState("");
  const postes = beneficiaries.filter((b) => personneVivante(b.status)).flatMap((b) =>
    b.cells.filter((c) => c.kind === "SERVICE" && c.status !== "WAIVED" && c.status !== "SETTLED").map((c) => ({ ...c, who: b.name })));
  const kinds = parCategorie ? [categorie] : postes.filter((c) => coches.has(c.id)).map((c) => c.serviceKind);
  const devises = new Set(kinds.map((k) => deviseDuPoste(scope, k)));
  const devise = devises.size === 1 ? [...devises][0]! : null;
  const n = Number(montant.replace(/[\s ]/g, "").replace(",", "."));
  const categories: CareServiceKind[] = ["TICKET", "HOTEL", "TRANSPORT", "CATERING", "REGISTRATION", "OTHER"];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        f.set("scope", scope);
        f.set("requestId", requestId);
        f.set("amount", montant);
        if (parCategorie) f.set("categorie", categorie);
        else for (const id of coches) f.append("cellIds", id);
        onSubmit(f);
      }}
      className="space-y-2 rounded-xl border border-border p-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <label className="text-xs">Fournisseur<input name="supplier" required placeholder="Agence de voyage, hôtel…" className={CHAMP} /></label>
        <label className="text-xs">Référence<input name="reference" placeholder="Facultatif" className={CHAMP} /></label>
        <label className="text-xs">Montant ({devise ?? "—"})
          <input inputMode="decimal" required value={montant} onChange={(e) => setMontant(e.target.value)} className={`${CHAMP} tabular-nums`} />
          {devise === "USD" && montant && Number.isFinite(n) && <span className="text-[0.6875rem] text-primary">≈ {formatCurrency(versDzd(n, "USD", taux) ?? 0)}</span>}
        </label>
        <label className="text-xs">Devis (PDF)<input name="file" type="file" accept="application/pdf,image/*" className="mt-1 block w-full text-xs" /></label>
      </div>
      {devises.size > 1 && <p className="text-xs text-destructive">Un devis couvre soit des billets (en DZD), soit d&apos;autres postes (en dollars) : enregistrez-en un pour chaque.</p>}

      <div className="flex flex-wrap gap-2 text-xs">
        {([[true, "Une catégorie, pour tout le groupe"], [false, "Des postes choisis"]] as const).map(([v, l]) => (
          <button key={l} type="button" onClick={() => setParCategorie(v)}
            className={`min-h-9 rounded-lg border px-2.5 py-1 sm:min-h-0 ${parCategorie === v ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-secondary"}`}>{l}</button>
        ))}
      </div>
      {parCategorie ? (
        <label className="block text-xs">Catégorie
          <select value={categorie} onChange={(e) => setCategorie(e.target.value as CareServiceKind)} className={CHAMP}>
            {categories.map((k) => <option key={k} value={k}>{SERVICE_KIND_LABELS[k]}</option>)}
          </select>
        </label>
      ) : (
        <fieldset className="rounded-lg border border-border p-2">
          <legend className="px-1 text-xs font-medium">Ce que ce devis couvre</legend>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {postes.length === 0 && <p className="text-xs text-muted-foreground">Aucun poste à couvrir.</p>}
            {postes.map((c) => (
              <label key={c.id} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
                <input type="checkbox" checked={coches.has(c.id)} className="h-4 w-4 shrink-0"
                  onChange={() => setCoches((s) => { const x = new Set(s); if (x.has(c.id)) x.delete(c.id); else x.add(c.id); return x; })} />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{c.label} <span className="text-xs text-muted-foreground">— {c.who}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <label className="block text-xs">Note<input name="note" placeholder="Facultatif" className={CHAMP} /></label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" type="submit" className="w-full sm:w-auto" disabled={busy || devises.size > 1}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Enregistrer le devis</Button>
        <Button size="sm" type="button" variant="outline" className="w-full sm:w-auto" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/**
 * LES PIÈCES DE CHAQUE PROFESSIONNEL — une liste compacte, une ligne par personne proposée ou accordée :
 * chaque pièce attendue (national : passeport, facultatif pour réserver ; international : passeport, visa,
 * informations de voyage) avec son état, le dépôt du fichier sur SA pièce, et la demande des pièces en un clic.
 */
function PiecesDesProfessionnels({ scope, requestId, beneficiaries, canEdit, busy, run }: {
  scope: Perimetre; requestId: string; beneficiaries: BeneficiaryRow[]; canEdit: boolean; busy: string | null; run: Run;
}) {
  const vivants = beneficiaries.filter((b) => personneVivante(b.status));
  if (vivants.length === 0) return null;
  const lignes = vivants.map((b) => ({ b, pieces: piecesDuProfessionnel(scope, b.cells) }));
  const attendues = lignes.reduce((n, l) => n + l.pieces.filter((p) => p.etat !== "SANS_OBJET").length, 0);
  const recues = lignes.reduce((n, l) => n + l.pieces.filter((p) => p.etat === "RECUE").length, 0);
  return (
    <section className="space-y-2 border-t border-border pt-4" aria-label="Pièces des professionnels">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Pièces des professionnels</h3>
        <span className="text-xs text-muted-foreground">{recues}/{attendues} reçue{recues > 1 ? "s" : ""}</span>
        {canEdit && (
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy !== null}
            onClick={() => void run("pieces", () => demanderPiecesPriseEnCharge(undefined, fd({ scope, requestId })))}>
            {busy === "pieces" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Demander les pièces
          </Button>
        )}
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {lignes.map(({ b, pieces }) => (
          <li key={b.id} className="flex flex-col gap-1.5 px-2.5 py-2 text-sm sm:flex-row sm:items-start">
            <span className="min-w-0 font-medium [overflow-wrap:anywhere] sm:w-48 sm:shrink-0">{b.name}</span>
            <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {pieces.map((p) => (
                <li key={p.cellId ?? p.label} className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border px-1.5 py-0.5 text-xs">
                  <span>{p.label}</span>
                  <Badge tone={p.etat === "RECUE" ? "success" : p.etat === "SANS_OBJET" ? "neutral" : p.etat === "DEMANDEE" ? "warning" : "danger"} dot={false}>
                    {ETAT_PIECE_LABELS[p.etat]}
                  </Badge>
                  {p.documentId && <a href={`/api/documents/${p.documentId}`} target="_blank" rel="noreferrer" className="px-1 py-1.5 text-primary hover:underline sm:p-0">voir</a>}
                  {canEdit && p.cellId && (p.etat === "DEMANDEE" || p.etat === "RECUE") && (
                    <label className="cursor-pointer px-1 py-1.5 text-primary hover:underline sm:p-0">
                      {busy === `dep:${p.cellId}` ? "envoi…" : p.etat === "RECUE" ? "remplacer" : "déposer"}
                      <input
                        type="file" className="sr-only" aria-label={`Déposer « ${p.label} » de ${b.name}`}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (!f || !p.cellId) return;
                          const form = new FormData();
                          form.set("cellId", p.cellId);
                          form.set("file", f);
                          e.target.value = "";
                          void run(`dep:${p.cellId}`, () => deposerPiecePriseEnCharge(undefined, form));
                        }}
                      />
                    </label>
                  )}
                  {canEdit && p.cellId && (
                    <select
                      value=""
                      onChange={(e) => {
                        if (!e.target.value || !p.cellId) return;
                        void run(`cs:${p.cellId}`, () => setCareCellStatus(undefined, fd({ id: p.cellId!, status: e.target.value })), "État mis à jour.");
                      }}
                      aria-label={`Changer l'état de « ${p.label} » de ${b.name}`}
                      className="min-h-8 rounded border border-border bg-background px-1 py-0.5 text-base outline-none sm:min-h-0 sm:text-[0.6875rem]"
                    >
                      <option value="">…</option>
                      {(["REQUESTED", "PROVIDED", "SETTLED", "WAIVED"] as CareCellStatus[]).map((s) => (
                        <option key={s} value={s}>{CELL_STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
