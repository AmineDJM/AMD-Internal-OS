"use client";

import * as React from "react";
import {
  ArrowLeft, BedDouble, Car, FileText, Loader2, MoreHorizontal, Plane, Plus, Save, Send, Ticket, Trash2, Upload, UtensilsCrossed,
  CircleEllipsis, CheckCircle2, ThumbsDown, ThumbsUp, Minus,
} from "lucide-react";
import type { CareCellStatus, CareMode, CareOpinion, CareServiceKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import type { BadgeTone } from "@/lib/labels";
import {
  autresPostes, billetPrincipal, deviseDuPoste, etapesDuBillet, etatBilletterie, etatHotellerie, hotelPrerempli,
  manquesPourReserverFiche, montantLisible, nuitsDuPoste, personnesDuPosteGroupe, postesDeNature, prochainGesteFiche, resumeBillet,
  resumeHotel, versDzd, DECISION_LIBELLE, GESTE_LIBELLE, TYPES_POSTE,
  type BeneficiaryRow, type CellRow, type DetailTrajet, type GroupPosteRow, type Perimetre, type QuoteRow, type Ton,
} from "../../domaine/prise-en-charge/fiches";
import { piecesDuProfessionnel, CELL_STATUS_LABELS, ETAT_PIECE_LABELS, OPINION_LABELS } from "../../domaine/prise-en-charge/regles";
import { TRANSPORTS, TRANSPORT_LIBELLE, ETAPES_MAX, type EtapeTrajet } from "../../domaine/voyageurs";
import { TYPES_CHAMBRE } from "../../domaine/hebergements";
import { addCareCell, decideCareBeneficiary, removeCareBeneficiary, removeCareCell, setCareCellStatus, setCareOpinion, linkCareCellPromoMaterial } from "../../actions-prise-en-charge";
import { deposerPiecePriseEnCharge, enregistrerBilletEmis, modifierPosteFiche, retirerFichierPiecePriseEnCharge, demanderBCPriseEnCharge, modifierPosteGroupe, retenirDevisPriseEnCharge } from "../../actions-prise-en-charge-logistique";
import { DocumentPreview } from "@/components/documents/document-preview";
import { BoutonLivret } from "./bouton-livret";
import { EnvoiFiche } from "@/components/reservation-fiche/envoi-fiche";
import type { EnvoiVue } from "@/lib/reservation-fiche/etat";

export type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText?: string) => Promise<unknown>;

export const TON_BADGE: Record<Ton, BadgeTone> = { succes: "success", attente: "warning", info: "info", neutre: "neutral", alerte: "danger" };

export const CHAMP = "mt-1 w-full min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5 text-base outline-none focus:border-primary/60 sm:text-sm";
const ETIQUETTE = "block min-w-0 text-xs text-muted-foreground";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const dzd = (n: number) => montantLisible(n, "DZD");

export function initiales(nom: string): string {
  const mots = nom.replace(/^(dr|pr|prof|mme|m)\.?\s+/i, "").split(/\s+/).filter(Boolean);
  return ((mots[0]?.[0] ?? "") + (mots[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function PastilleDecision({ status }: { status: BeneficiaryRow["status"] }) {
  const tone: BadgeTone = status === "APPROVED" ? "success" : status === "REJECTED" ? "danger" : status === "WITHDRAWN" ? "neutral" : "warning";
  return <Badge tone={tone} dot={false}>{DECISION_LIBELLE[status]}</Badge>;
}

interface FicheProps {
  scope: Perimetre;
  requestId: string;
  mode: CareMode;
  b: BeneficiaryRow;
  quotes: QuoteRow[];
  groupPostes: GroupPosteRow[];
  personnes: { id: string; status: BeneficiaryRow["status"] }[];
  taux: number | null;
  eventCity: string | null;
  /** La valeur de chaque case (part des devis, ou montant saisi) — voir `estimations`. */
  parCase: Map<string, number>;
  estime: number;
  canEdit: boolean;
  canDecide: boolean;
  peutTeleverser: boolean;
  /** Les supports promotionnels rattachables à un poste (⋯ du poste). */
  promoOptions: { id: string; reference: string; title: string }[];
  busy: string | null;
  run: Run;
  onRetour: () => void;
  /** Ouvre l'enregistrement d'un devis (le formulaire de la demande), pour ces cases. */
  onDevis: (cellIds: string[]) => void;
  /** L'état de chaque billet / hôtel chez l'assistante de direction (par case) — 14/10. */
  envois?: Record<string, EnvoiVue>;
}

/**
 * LA FICHE VOYAGEUR D'UNE PERSONNE (Direction, 10/2026) — l'en-tête (identité, décision, menu), la billetterie et
 * l'hôtellerie ouvertes, les autres postes avec un « + » par catégorie, et sur le côté le prochain geste, les
 * documents et la décision. Les règles sont celles de `lib/care-fiches.ts` (et, pour le billet et l'hôtel, celles
 * du sponsoring). Le mode « de groupe » cache les montants par fiche : les prix vivent au niveau du groupe.
 */
export function FicheVoyageur(p: FicheProps) {
  const { scope, mode, b, quotes, canEdit, canDecide, busy, run } = p;
  const [menu, setMenu] = React.useState(false);
  const pieces = piecesDuProfessionnel(scope, b.cells);
  const passeport = pieces.find((x) => x.label === "Passeport");
  const passeportRecu = passeport?.etat === "RECUE";
  const devisLike = quotes.map((q) => ({ id: q.id, status: q.status, amountDzd: q.amountDzd, cellIds: q.cellIds, retained: q.retained, bcRequested: q.bcRequested }));
  const geste = prochainGesteFiche(scope, b.name, b.cells, passeportRecu, devisLike, canEdit);
  const manques = manquesPourReserverFiche(scope, b.name, b.cells, passeportRecu);
  const billets = postesDeNature(b.cells, "TICKET");
  const hotels = postesDeNature(b.cells, "HOTEL");
  const autres = autresPostes(b.cells).filter((c) => c.serviceKind !== "TICKET" && c.serviceKind !== "HOTEL");
  const principal = billetPrincipal(b.cells);
  const groupe = mode === "GROUP";
  const somme = (cs: CellRow[]) => cs.reduce((s, c) => s + (c.status === "WAIVED" ? 0 : p.parCase.get(c.id) ?? 0), 0);
  const partGroupe = p.groupPostes.filter((g) => personnesDuPosteGroupe(g, p.personnes).some((x) => x.id === b.id)).reduce((s, g) => s + (g.status === "WAIVED" ? 0 : g.unitAmountDzd ?? 0), 0);
  const retenusDeLaFiche = quotes.filter((q) => q.status === "PENDING" && q.retained && !q.bcRequested && b.cells.some((c) => q.cellIds.includes(c.id)));
  const docRef = React.useRef<HTMLDivElement>(null);

  const ajouter = (cle: string) => void run(`add:${b.id}:${cle}`, () => addCareCell(undefined, fd({ beneficiaryId: b.id, posteType: cle })), "Poste ajouté.");

  return (
    <div className="space-y-3">
      <button type="button" onClick={p.onRetour} className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary hover:underline sm:min-h-0">
        <ArrowLeft className="h-3.5 w-3.5" /> Professionnels de la demande
      </button>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 rounded-xl border border-border bg-card">
          {/* L'en-tête : qui, d'où, la décision, et le menu. */}
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <span aria-hidden className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">{initiales(b.name)}</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold [overflow-wrap:anywhere]">{b.name}</p>
              <p className="text-xs text-muted-foreground">{[b.subtitle, b.fromDirectory ? "fiche de l'annuaire" : "profil libre"].filter(Boolean).join(" · ")}</p>
            </div>
            <PastilleDecision status={b.status} />
            {p.peutTeleverser && (b.status === "PROPOSED" || b.status === "APPROVED") && (
              <BoutonLivret scope={scope} requestId={p.requestId} personneId={b.id} libelle="Livret" />
            )}
            {(canEdit || canDecide) && (
              <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label={`Autres actions pour ${b.name}`}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            )}
          </div>
          {menu && (
            <div className="space-y-2 border-b border-border bg-secondary/30 px-4 py-3 text-xs" role="menu">
              {canEdit && b.status === "PROPOSED" && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground">Avis du demandeur :</span>
                  {(["FAVORABLE", "UNFAVORABLE", "NONE"] as CareOpinion[]).map((o) => (
                    <button key={o} type="button" disabled={busy !== null}
                      onClick={() => void run(`op:${b.id}`, () => setCareOpinion(undefined, fd({ id: b.id, opinion: o })), "Avis enregistré.")}
                      className={`inline-flex min-h-9 items-center gap-1 rounded-lg border px-2 py-1 sm:min-h-0 ${b.requesterOpinion === o ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-secondary"}`}>
                      {o === "FAVORABLE" ? <ThumbsUp className="h-3 w-3" /> : o === "UNFAVORABLE" ? <ThumbsDown className="h-3 w-3" /> : <Minus className="h-3 w-3" />} {OPINION_LABELS[o]}
                    </button>
                  ))}
                </div>
              )}
              {canDecide && b.status === "PROPOSED" && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy !== null} onClick={() => void run(`dec:${b.id}`, () => decideCareBeneficiary(undefined, fd({ id: b.id, decision: "APPROVED" })), "Prise en charge accordée.")}>
                    <ThumbsUp className="h-4 w-4" /> Accorder
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(`dec:${b.id}`, () => decideCareBeneficiary(undefined, fd({ id: b.id, decision: "REJECTED" })), "Personne écartée.")}>
                    <ThumbsDown className="h-4 w-4" /> Écarter
                  </Button>
                </div>
              )}
              {canEdit && b.status !== "APPROVED" && (
                <button type="button" disabled={busy !== null}
                  onClick={() => { if (window.confirm(`Retirer ${b.name} de la prise en charge ?`)) void run(`bd:${b.id}`, () => removeCareBeneficiary(undefined, fd({ id: b.id })), "Personne retirée.").then(p.onRetour); }}
                  className="inline-flex min-h-9 items-center gap-1 text-destructive hover:underline sm:min-h-0">
                  <Trash2 className="h-3.5 w-3.5" /> Retirer de la demande
                </button>
              )}
            </div>
          )}

          {/* BILLETTERIE — le billet principal, puis les billets en plus. */}
          {billets.length === 0 ? (
            <SectionVide icone={<Plane className="h-4 w-4" />} titre="Billetterie" texte="Pas de billet ouvert." action={canEdit ? () => ajouter("BILLET") : undefined} busy={busy} />
          ) : billets.map((c, i) => (
            <PosteBillet key={c.id} {...p} c={c} principal={i === 0} passeportRecu={passeportRecu} />
          ))}

          {/* HÔTELLERIE — l'hôtel principal, puis les hôtels en plus. */}
          {hotels.length === 0 ? (
            <SectionVide icone={<BedDouble className="h-4 w-4" />} titre="Hôtellerie" texte="Pas d'hôtel ouvert." action={canEdit ? () => ajouter("HOTEL") : undefined} busy={busy} />
          ) : hotels.map((c, i) => (
            <PosteHotel key={c.id} {...p} c={c} principal={i === 0} billet={principal} />
          ))}

          {/* AUTRES POSTES — un « + » par catégorie, autant de fois qu'il le faut. */}
          <div className="border-t border-border">
            <div className="flex items-center gap-2.5 px-4 py-3">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Plus className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Autres postes</p>
              </div>
              <Badge tone="neutral" dot={false}>{autres.length} poste{autres.length > 1 ? "s" : ""}</Badge>
            </div>
            {autres.map((c) => <PosteAutre key={c.id} {...p} c={c} />)}
            {canEdit && (
              <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3" aria-label="Ajouter un poste à cette fiche">
                {TYPES_POSTE.map((t) => (
                  <button key={t.cle} type="button" disabled={busy !== null} onClick={() => ajouter(t.cle)} title={t.aide}
                    className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium hover:border-primary hover:text-primary sm:min-h-0">
                    {busy === `add:${b.id}:${t.cle}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <IconePoste kind={t.serviceKind} />} {t.libelle}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Les postes de groupe qui s'appliquent à cette personne — une exclusion d'un geste. */}
          {p.groupPostes.length > 0 && (
            <div className="space-y-1.5 border-t border-border px-4 py-3 text-xs">
              <p className="font-medium">Postes de groupe</p>
              {p.groupPostes.map((g) => {
                const exclue = g.excludedBeneficiaryIds.includes(b.id);
                return (
                  <div key={g.id} className="flex flex-wrap items-center gap-2">
                    <span className={exclue ? "text-muted-foreground line-through" : ""}>{g.label}</span>
                    {g.unitAmount != null && <span className="tabular-nums text-muted-foreground">{montantLisible(g.unitAmount, g.currency)} / pers.</span>}
                    {canEdit && (
                      <button type="button" disabled={busy !== null} className="text-primary hover:underline"
                        onClick={() => void run(`gx:${g.id}`, () => modifierPosteGroupe(undefined, fd(exclue ? { id: g.id, inclure: b.id } : { id: g.id, exclure: b.id })))}>
                        {exclue ? "réinclure" : "exclure"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap justify-between gap-2 rounded-b-xl border-t border-border bg-secondary/40 px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Total de la fiche · billetterie {dzd(somme(billets))} · hôtellerie {dzd(somme(hotels))} · autres {dzd(somme(autres))}
              {partGroupe > 0 ? ` · groupe ${dzd(partGroupe)}` : ""}
            </span>
            <b className="tabular-nums">{dzd(p.estime)}</b>
          </div>
        </div>

        {/* LE CÔTÉ : le prochain geste, les documents, la décision. */}
        <div className="min-w-0 space-y-3">
          <Carte titre="Prochain geste">
            {geste === null ? (
              <p>{manques.length === 0 ? "Rien n'attend de geste ici." : `À préciser : ${manques.join(", ")}.`}</p>
            ) : geste === "BC" ? (
              <>
                <p>Tout est prêt pour cette personne.</p>
                <Button size="sm" disabled={busy !== null}
                  onClick={() => {
                    const form = fd({ scope, requestId: p.requestId });
                    for (const q of retenusDeLaFiche) form.append("quoteIds", q.id);
                    void run(`bc:${b.id}`, () => demanderBCPriseEnCharge(undefined, form));
                  }}>
                  {busy === `bc:${b.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Demander le BC ({retenusDeLaFiche.length} devis retenu{retenusDeLaFiche.length > 1 ? "s" : ""})
                </Button>
                <p className="text-xs text-muted-foreground">Le BC part à l&apos;assistante de direction, comme pour le sponsoring.</p>
              </>
            ) : geste === "PASSEPORT" ? (
              <Button size="sm" variant="outline" onClick={() => docRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                <Upload className="h-4 w-4" /> {GESTE_LIBELLE.PASSEPORT}
              </Button>
            ) : geste === "COMPLETER" ? (
              <p>{GESTE_LIBELLE.COMPLETER} : {manques.join(", ")}.</p>
            ) : geste === "DEVIS" ? (
              <Button size="sm" variant="outline" onClick={() => p.onDevis(b.cells.filter((c) => c.kind === "SERVICE" && c.status !== "WAIVED" && c.status !== "SETTLED").map((c) => c.id))}>
                <FileText className="h-4 w-4" /> {GESTE_LIBELLE.DEVIS}
              </Button>
            ) : (
              <p>{GESTE_LIBELLE.RETENIR} : choisissez la proposition sous le poste concerné.</p>
            )}
          </Carte>

          <div ref={docRef}>
            <Carte titre="Documents">
              {pieces.length === 0 && <p className="text-muted-foreground">Aucune pièce demandée — « Demander les pièces » sous la liste.</p>}
              {pieces.map((x) => {
                // TOUS LES FICHIERS DE LA PIÈCE (Direction, 10/2026) — recto, verso, pages, visa : chacun s'ouvre, et
                // se retire tant que la pièce n'est pas validée. Le dernier retiré, la pièce redevient attendue.
                const cellule = x.cellId ? b.cells.find((c) => c.id === x.cellId) : undefined;
                const fichiers = cellule?.fichiers ?? (x.documentId ? [{ id: x.documentId, name: x.label, hasFile: true }] : []);
                const modifiable = canEdit && Boolean(x.cellId) && (x.etat === "DEMANDEE" || x.etat === "RECUE");
                return (
                  <div key={x.cellId ?? x.label} className="space-y-1 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={x.etat === "RECUE" ? "success" : x.etat === "SANS_OBJET" ? "neutral" : x.etat === "DEMANDEE" ? "warning" : "danger"} dot={false}>
                        {x.label === "Passeport" && scope === "NATIONAL" ? "Pièce d'identité (facultative)" : x.label}
                      </Badge>
                      <span className="text-muted-foreground">
                        {ETAT_PIECE_LABELS[x.etat]}{fichiers.length > 1 ? ` · ${fichiers.length} fichiers` : ""}
                      </span>
                      {modifiable && x.cellId && (
                        <label className="cursor-pointer px-1 py-1.5 text-primary hover:underline sm:p-0">
                          {busy === `dep:${x.cellId}` ? "envoi…" : fichiers.length > 0 ? "ajouter des fichiers" : "déposer"}
                          <input type="file" multiple className="sr-only" aria-label={`Déposer « ${x.label} » de ${b.name} (un ou plusieurs fichiers)`}
                            onChange={(e) => {
                              const choisis = Array.from(e.target.files ?? []);
                              e.target.value = "";
                              if (choisis.length === 0 || !x.cellId) return;
                              const form = new FormData();
                              form.set("cellId", x.cellId);
                              for (const f of choisis) form.append("file", f);
                              void run(`dep:${x.cellId}`, () => deposerPiecePriseEnCharge(undefined, form));
                            }} />
                        </label>
                      )}
                    </div>
                    {fichiers.length > 0 && (
                      <ul className="space-y-0.5 pl-2" aria-label={`Fichiers de « ${x.label} »`}>
                        {fichiers.map((f) => (
                          <li key={f.id} className="flex min-w-0 items-center gap-1.5">
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <DocumentPreview id={f.id} name={f.name} hasFile={f.hasFile} canDelete={modifiable} supprimer={retirerFichierPiecePriseEnCharge} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              {[...billets, ...hotels].filter((c) => c.issuedDocumentId).map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge tone="success" dot={false}>{c.serviceKind === "TICKET" ? "billet émis" : "confirmation d'hôtel"}</Badge>
                  <a href={`/api/documents/${c.issuedDocumentId}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{c.label}</a>
                  {c.bookingRef && <span className="text-muted-foreground">réf. {c.bookingRef}</span>}
                </div>
              ))}
            </Carte>
          </div>

          <Carte titre="Décision">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Avis du demandeur</dt>
              <dd>{OPINION_LABELS[b.requesterOpinion]}{b.requesterNote ? ` — ${b.requesterNote}` : ""}</dd>
              <dt className="text-muted-foreground">Direction</dt>
              <dd>{DECISION_LIBELLE[b.status]}{b.decisionNote ? ` — ${b.decisionNote}` : ""}</dd>
            </dl>
          </Carte>
        </div>
      </div>
    </div>
  );
}

function Carte({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <p className="border-b border-border px-4 py-2.5 text-sm font-semibold">{titre}</p>
      <div className="space-y-2 px-4 py-3 text-sm">{children}</div>
    </div>
  );
}

export function IconePoste({ kind, className = "h-3.5 w-3.5" }: { kind: CareServiceKind | null; className?: string }) {
  if (kind === "TICKET") return <Plane className={className} />;
  if (kind === "HOTEL") return <BedDouble className={className} />;
  if (kind === "TRANSPORT") return <Car className={className} />;
  if (kind === "CATERING") return <UtensilsCrossed className={className} />;
  if (kind === "REGISTRATION") return <Ticket className={className} />;
  return <CircleEllipsis className={className} />;
}

function SectionVide({ icone, titre, texte, action, busy }: { icone: React.ReactNode; titre: string; texte: string; action?: () => void; busy: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-border px-4 py-3 first:border-t-0">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground">{icone}</span>
      <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{titre}</p><p className="text-xs text-muted-foreground">{texte}</p></div>
      {action && <Button size="sm" variant="outline" disabled={busy !== null} onClick={action}><Plus className="h-4 w-4" /> Ouvrir</Button>}
    </div>
  );
}

/** L'en-tête d'un poste : icône, titre, résumé, état. */
function TetePoste({ kind, titre, resume, etat }: { kind: CareServiceKind | null; titre: string; resume: string; etat: { libelle: string; ton: Ton } | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-4 py-3">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><IconePoste kind={kind} className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{titre}</p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{resume}</p>
      </div>
      {etat && <Badge tone={TON_BADGE[etat.ton]} dot={false}>{etat.libelle}</Badge>}
    </div>
  );
}

type PosteProps = FicheProps & { c: CellRow };

/** Le montant d'un poste, dans sa devise, avec son équivalent DZD (le dollar à l'international, sauf le billet). */
function ChampMontant({ scope, kind, taux, valeur, onChange, id }: {
  scope: Perimetre; kind: CareServiceKind | null; taux: number | null; valeur: string; onChange: (v: string) => void; id: string;
}) {
  const devise = deviseDuPoste(scope, kind);
  const n = Number(valeur.replace(/[\s ]/g, "").replace(",", "."));
  const equivalent = devise === "USD" && valeur.trim() && Number.isFinite(n) ? versDzd(n, "USD", taux) : null;
  return (
    <label className={ETIQUETTE} htmlFor={id}>
      <span className="inline-flex items-center gap-1">
        Montant ({devise})
        {devise === "USD" && <InfoBulle label="Pourquoi en dollars ?">À l&apos;international, tout sauf la billetterie se saisit en dollars et entre au budget à 1 USD = {taux ?? "?"} DZD (taux figé sur la demande).</InfoBulle>}
      </span>
      <input id={id} inputMode="decimal" value={valeur} onChange={(e) => onChange(e.target.value)} placeholder="Montant estimé" className={`${CHAMP} tabular-nums`} />
      {equivalent != null && <span className="text-[0.6875rem] text-primary">≈ {dzd(equivalent)}</span>}
    </label>
  );
}

const montantInitial = (c: CellRow) => (c.amount != null ? String(c.amount) : c.amountDzd != null && c.currency === "DZD" ? String(c.amountDzd) : "");

/** Les devis qui couvrent ce poste — retenir, voir le PDF. Un dépassement se dit au niveau de la demande. */
function DevisDuPoste({ c, quotes, canEdit, busy, run }: { c: CellRow; quotes: QuoteRow[]; canEdit: boolean; busy: string | null; run: Run }) {
  const qs = quotes.filter((q) => q.cellIds.includes(c.id));
  if (qs.length === 0) return null;
  const unRetenu = qs.some((q) => q.retained || q.status === "ACCEPTED");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="text-muted-foreground">Devis :</span>
      {qs.map((q) => {
        const etat = q.status === "ACCEPTED" ? { l: "accepté", t: "success" as const } : q.status === "REJECTED" ? { l: "refusé", t: "danger" as const }
          : q.retained ? { l: q.bcRequested ? "retenu · BC demandé" : "retenu", t: "success" as const } : unRetenu ? { l: "écarté", t: "neutral" as const } : { l: "à choisir", t: "info" as const };
        return (
          <span key={q.id} className="inline-flex flex-wrap items-center gap-1">
            {q.documentId ? <a href={`/api/documents/${q.documentId}`} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{q.supplier}{q.reference ? ` ${q.reference}` : ""}</a> : <span>{q.supplier}{q.reference ? ` ${q.reference}` : ""}</span>}
            <span className="tabular-nums">{q.amount != null && q.currency === "USD" ? `${montantLisible(q.amount, "USD")} (${dzd(q.amountDzd)})` : dzd(q.amountDzd)}</span>
            <Badge tone={etat.t} dot={false}>{etat.l}</Badge>
            {canEdit && q.status === "PENDING" && !q.retained && !q.bcRequested && (
              <button type="button" disabled={busy !== null} className="font-medium text-primary hover:underline"
                onClick={() => void run(`ret:${q.id}`, () => retenirDevisPriseEnCharge(undefined, fd({ id: q.id })))}>retenir</button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** « Sans billet » / « sans hôtel » en un geste — la case principale « sans objet » ; « Rouvrir » la remet en demande. */
function BoutonSans({ c, quoi, busy, run }: { c: CellRow; quoi: string; busy: string | null; run: Run }) {
  const sans = c.status === "WAIVED";
  return (
    <Button type="button" size="sm" variant="ghost" disabled={busy !== null || Boolean(c.expenseOrderId)}
      onClick={() => void run(`sans:${c.id}`, () => setCareCellStatus(undefined, fd({ id: c.id, status: sans ? "REQUESTED" : "WAIVED" })), sans ? "Poste rouvert." : `Marqué « ${quoi} ».`)}>
      {sans ? "Rouvrir" : quoi.charAt(0).toUpperCase() + quoi.slice(1)}
    </Button>
  );
}

function PosteBillet(p: PosteProps & { principal: boolean; passeportRecu: boolean }) {
  const { c, scope, canEdit, busy, run, principal } = p;
  const [trajet, setTrajet] = React.useState(c.trajet ?? "ALLER_RETOUR");
  const [de, setDe] = React.useState(c.fromCity ?? "");
  const [vers, setVers] = React.useState(c.toCity ?? p.eventCity ?? "");
  const [depart, setDepart] = React.useState(c.dateStart ?? "");
  const [retour, setRetour] = React.useState(c.dateEnd ?? "");
  const [etapes, setEtapes] = React.useState<EtapeTrajet[]>(c.segments.length ? c.segments : [{ de: c.fromCity, vers: c.toCity, date: c.dateStart }]);
  const [transport, setTransport] = React.useState(c.transport ?? "");
  const [notes, setNotes] = React.useState(c.notes ?? "");
  const [montant, setMontant] = React.useState(montantInitial(c));
  const etat = principal
    ? etatBilletterie(scope, p.b.name, p.b.cells, p.passeportRecu, p.quotes)
    : { libelle: CELL_STATUS_LABELS[c.status], ton: (c.status === "SETTLED" ? "succes" : "neutre") as Ton };
  const sans = c.status === "WAIVED";
  const edit = canEdit && !sans;

  const enregistrer = () => {
    const f = fd({
      id: c.id, trajet, transport, notes, fromCity: de, toCity: vers, dateStart: depart, dateEnd: trajet === "ALLER_SIMPLE" ? "" : retour,
      segments: trajet === "MULTI_DESTINATIONS" ? JSON.stringify(etapes) : "",
    });
    if (p.mode === "INDIVIDUAL") f.set("amount", montant);
    void run(`pb:${c.id}`, () => modifierPosteFiche(undefined, f));
  };

  return (
    <div className="border-t border-border first:border-t-0">
      <TetePoste kind="TICKET" titre={c.label} resume={sans ? "sans billet — vient par ses propres moyens" : resumeBillet(c)} etat={etat} />
      {!sans && p.envois?.[c.id] && <div className="px-4 pb-2 sm:pl-14"><EnvoiFiche envoi={p.envois[c.id]} peutEditer={canEdit} busy={busy} run={run} /></div>}
      {!sans && (
        <div className="space-y-2.5 px-4 pb-3 sm:pl-14">
          <div role="radiogroup" aria-label="Trajet" className="inline-flex flex-wrap gap-0.5 rounded-lg bg-secondary p-0.5">
            {([["ALLER_SIMPLE", "Aller"], ["ALLER_RETOUR", "Aller-Retour"], ["MULTI_DESTINATIONS", "Multi-destinations"]] as const).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={trajet === v} disabled={!edit} onClick={() => setTrajet(v)}
                className={`min-h-9 rounded-md px-2.5 py-1 text-xs font-medium sm:min-h-0 ${trajet === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{l}</button>
            ))}
          </div>
          {trajet === "MULTI_DESTINATIONS" ? (
            <div className="space-y-1.5">
              {etapes.map((e, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px_auto] sm:items-end">
                  <label className={ETIQUETTE}>Point {String.fromCharCode(65 + i)} — départ<input value={e.de ?? ""} disabled={!edit} onChange={(ev) => setEtapes((l) => l.map((x, k) => (k === i ? { ...x, de: ev.target.value } : x)))} className={CHAMP} /></label>
                  <label className={ETIQUETTE}>Arrivée<input value={e.vers ?? ""} disabled={!edit} onChange={(ev) => setEtapes((l) => l.map((x, k) => (k === i ? { ...x, vers: ev.target.value } : x)))} className={CHAMP} /></label>
                  <label className={ETIQUETTE}>Date<input type="date" value={e.date ?? ""} disabled={!edit} onChange={(ev) => setEtapes((l) => l.map((x, k) => (k === i ? { ...x, date: ev.target.value } : x)))} className={CHAMP} /></label>
                  {edit && etapes.length > 1 ? (
                    <button type="button" onClick={() => setEtapes((l) => l.filter((_, k) => k !== i))} aria-label={`Retirer l'étape ${i + 1}`} className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                  ) : <span />}
                </div>
              ))}
              {edit && etapes.length < ETAPES_MAX && (
                <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setEtapes((l) => [...l, { de: l[l.length - 1]?.vers ?? null, vers: null, date: null }])}>
                  + Destination suivante
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <label className={ETIQUETTE}>Point A — départ<input value={de} disabled={!edit} onChange={(e) => setDe(e.target.value)} placeholder="Alger" className={CHAMP} /></label>
              <label className={ETIQUETTE}>Point B — arrivée<input value={vers} disabled={!edit} onChange={(e) => setVers(e.target.value)} className={CHAMP} /></label>
              <label className={ETIQUETTE}>Aller<input type="date" value={depart} disabled={!edit} onChange={(e) => setDepart(e.target.value)} className={CHAMP} /></label>
              {trajet === "ALLER_RETOUR" && <label className={ETIQUETTE}>Retour<input type="date" value={retour} disabled={!edit} onChange={(e) => setRetour(e.target.value)} className={CHAMP} /></label>}
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <label className={ETIQUETTE}>Mode
              <select value={transport} disabled={!edit} onChange={(e) => setTransport(e.target.value)} className={CHAMP}>
                <option value="">— à préciser —</option>
                {TRANSPORTS.map((t) => <option key={t} value={t}>{TRANSPORT_LIBELLE[t].charAt(0).toUpperCase() + TRANSPORT_LIBELLE[t].slice(1)}</option>)}
              </select>
            </label>
            <label className={`${ETIQUETTE} sm:col-span-2`}>Précisions<input value={notes} disabled={!edit} onChange={(e) => setNotes(e.target.value)} placeholder="Classe, horaire souhaité…" className={CHAMP} /></label>
            {p.mode === "INDIVIDUAL" && <ChampMontant scope={scope} kind="TICKET" taux={p.taux} valeur={montant} onChange={setMontant} id={`m-${c.id}`} />}
          </div>
          {principal && scope === "INTERNATIONAL" && (
            <p className="text-xs">{p.passeportRecu ? <span className="text-success">passeport reçu</span> : <span className="text-warning">passeport manquant — à déposer dans Documents</span>}</p>
          )}
          <DevisDuPoste c={c} quotes={p.quotes} canEdit={canEdit} busy={busy} run={run} />
          {edit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy !== null} onClick={enregistrer}>{busy === `pb:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Enregistrer</Button>
              {principal ? <BoutonSans c={c} quoi="sans billet" busy={busy} run={run} /> : <RetirerPoste c={c} busy={busy} run={run} />}
            </div>
          )}
          {p.peutTeleverser && <BilletEmis c={c} busy={busy} run={run} />}
        </div>
      )}
      {sans && canEdit && <div className="px-4 pb-3 sm:pl-14"><BoutonSans c={c} quoi="sans billet" busy={busy} run={run} /></div>}
    </div>
  );
}

function PosteHotel(p: PosteProps & { principal: boolean; billet: CellRow | null }) {
  const { c, scope, canEdit, busy, run, principal } = p;
  // LES DATES DU BILLET ET LA VILLE DE L'ÉVÉNEMENT, proposées tant que l'hôtel ne les a pas.
  const pre = hotelPrerempli({ city: p.eventCity }, p.billet);
  const [hotel, setHotel] = React.useState(c.hotelName ?? "");
  const [ville, setVille] = React.useState(c.city ?? pre.city ?? "");
  const [arrivee, setArrivee] = React.useState(c.dateStart ?? pre.dateStart ?? "");
  const [depart, setDepart] = React.useState(c.dateEnd ?? pre.dateEnd ?? "");
  const [chambre, setChambre] = React.useState(c.roomType ?? "");
  const [notes, setNotes] = React.useState(c.notes ?? "");
  const [montant, setMontant] = React.useState(montantInitial(c));
  const nuits = nuitsDuPoste({ dateStart: arrivee || null, dateEnd: depart || null });
  const etat = principal ? etatHotellerie(p.b.cells, p.quotes) : { libelle: CELL_STATUS_LABELS[c.status], ton: (c.status === "SETTLED" ? "succes" : "neutre") as Ton };
  const sans = c.status === "WAIVED";
  const edit = canEdit && !sans;
  const enregistrer = () => {
    const f = fd({ id: c.id, hotelName: hotel, city: ville, dateStart: arrivee, dateEnd: depart, roomType: chambre, notes });
    if (p.mode === "INDIVIDUAL") f.set("amount", montant);
    void run(`ph:${c.id}`, () => modifierPosteFiche(undefined, f));
  };
  return (
    <div className="border-t border-border">
      <TetePoste kind="HOTEL" titre={c.label} resume={sans ? "sans hôtel" : resumeHotel({ ...c, dateStart: arrivee || null, dateEnd: depart || null, hotelName: hotel || null, city: ville || null, roomType: chambre || null })} etat={etat} />
      {!sans && p.envois?.[c.id] && <div className="px-4 pb-2 sm:pl-14"><EnvoiFiche envoi={p.envois[c.id]} peutEditer={canEdit} busy={busy} run={run} /></div>}
      {!sans && (
        <div className="space-y-2.5 px-4 pb-3 sm:pl-14">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <label className={`${ETIQUETTE} sm:col-span-2`}>Hôtel<input value={hotel} disabled={!edit} onChange={(e) => setHotel(e.target.value)} className={CHAMP} /></label>
            <label className={ETIQUETTE}>Ville<input value={ville} disabled={!edit} onChange={(e) => setVille(e.target.value)} className={CHAMP} />
              {!c.city && pre.city && ville === pre.city && <span className="text-[0.6875rem] text-primary">reprise de l&apos;événement</span>}
            </label>
            <label className={ETIQUETTE}>Chambre
              <select value={chambre} disabled={!edit} onChange={(e) => setChambre(e.target.value)} className={CHAMP}>
                <option value="">—</option>
                {[...TYPES_CHAMBRE, ...(chambre && !(TYPES_CHAMBRE as readonly string[]).includes(chambre) ? [chambre] : [])].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className={ETIQUETTE}>Arrivée<input type="date" value={arrivee} disabled={!edit} onChange={(e) => setArrivee(e.target.value)} className={CHAMP} />
              {!c.dateStart && pre.dateStart && arrivee === pre.dateStart && <span className="text-[0.6875rem] text-primary">reprise du billet</span>}
            </label>
            <label className={ETIQUETTE}>Départ<input type="date" value={depart} disabled={!edit} onChange={(e) => setDepart(e.target.value)} className={CHAMP} />
              {!c.dateEnd && pre.dateEnd && depart === pre.dateEnd && <span className="text-[0.6875rem] text-primary">reprise du billet</span>}
            </label>
            <label className={ETIQUETTE}>Nuits<span className="mt-1 block py-1.5 text-sm text-foreground">{nuits == null ? "à préciser" : nuits}</span></label>
            {p.mode === "INDIVIDUAL" && <ChampMontant scope={scope} kind="HOTEL" taux={p.taux} valeur={montant} onChange={setMontant} id={`m-${c.id}`} />}
            <label className={`${ETIQUETTE} sm:col-span-4`}>Précisions<input value={notes} disabled={!edit} onChange={(e) => setNotes(e.target.value)} placeholder="Petit-déjeuner inclus…" className={CHAMP} /></label>
          </div>
          <DevisDuPoste c={c} quotes={p.quotes} canEdit={canEdit} busy={busy} run={run} />
          {edit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy !== null} onClick={enregistrer}>{busy === `ph:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Enregistrer</Button>
              {principal ? <BoutonSans c={c} quoi="sans hôtel" busy={busy} run={run} /> : <RetirerPoste c={c} busy={busy} run={run} />}
            </div>
          )}
          {p.peutTeleverser && <BilletEmis c={c} busy={busy} run={run} />}
        </div>
      )}
      {sans && canEdit && <div className="px-4 pb-3 sm:pl-14"><BoutonSans c={c} quoi="sans hôtel" busy={busy} run={run} /></div>}
    </div>
  );
}

function PosteAutre(p: PosteProps) {
  const { c, scope, canEdit, busy, run } = p;
  const [label, setLabel] = React.useState(c.label);
  const [notes, setNotes] = React.useState(c.notes ?? "");
  const [date, setDate] = React.useState(c.dateStart ?? "");
  const [heure, setHeure] = React.useState(c.timeStart ?? "");
  const [lieu, setLieu] = React.useState(c.address ?? "");
  const [montant, setMontant] = React.useState(montantInitial(c));
  const edit = canEdit && !c.expenseOrderId;
  const [menu, setMenu] = React.useState(false);
  const [support, setSupport] = React.useState(c.promoMaterialId ?? "");
  const enregistrer = () => {
    const f = fd({ id: c.id, label, notes, dateStart: date, timeStart: heure, address: lieu });
    if (p.mode === "INDIVIDUAL") f.set("amount", montant);
    void run(`pa:${c.id}`, () => modifierPosteFiche(undefined, f));
  };
  return (
    <div className="space-y-2 border-t border-border px-4 py-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end">
        <div className="flex items-center gap-2 sm:col-span-6">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><IconePoste kind={c.serviceKind} /></span>
          <input value={label} disabled={!edit} onChange={(e) => setLabel(e.target.value)} aria-label="Intitulé du poste" className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-sm font-semibold outline-none hover:border-border focus:border-primary/60" />
          <Badge tone={c.status === "SETTLED" ? "success" : c.status === "WAIVED" ? "neutral" : c.status === "PROVIDED" ? "info" : "warning"} dot={false}>{CELL_STATUS_LABELS[c.status]}</Badge>
          {edit && (
            <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label={`Autres actions pour « ${c.label} »`}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary sm:h-7 sm:w-7">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
        </div>
        {c.promoMaterial && (
          <p className="text-xs text-muted-foreground sm:col-span-6">
            Support promotionnel : <span className="text-foreground">{c.promoMaterial.reference} — {c.promoMaterial.title}</span> · {c.promoMaterial.status}
          </p>
        )}
        {menu && edit && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg bg-secondary/40 p-2 sm:col-span-6" role="menu">
            <label className={`${ETIQUETTE} w-full sm:w-auto sm:flex-1`}>Support promotionnel rattaché
              <select value={support} disabled={busy !== null} onChange={(e) => setSupport(e.target.value)} className={CHAMP}>
                <option value="">— aucun —</option>
                {p.promoOptions.map((o) => <option key={o.id} value={o.id}>{o.reference} — {o.title}</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" disabled={busy !== null || support === (c.promoMaterialId ?? "")}
              onClick={() => void run(`pm:${c.id}`, () => linkCareCellPromoMaterial(undefined, fd({ id: c.id, promoMaterialId: support })), support ? "Support rattaché." : "Support détaché.").then(() => setMenu(false))}>
              {busy === `pm:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Rattacher
            </Button>
          </div>
        )}
        <label className={`${ETIQUETTE} sm:col-span-2`}>Détail<input value={notes} disabled={!edit} onChange={(e) => setNotes(e.target.value)} placeholder="Restaurant, prestataire…" className={CHAMP} /></label>
        <label className={ETIQUETTE}>Date<input type="date" value={date} disabled={!edit} onChange={(e) => setDate(e.target.value)} className={CHAMP} /></label>
        <label className={ETIQUETTE}>Heure<input type="time" value={heure} disabled={!edit} onChange={(e) => setHeure(e.target.value)} className={CHAMP} /></label>
        <label className={`${ETIQUETTE} sm:col-span-2`}>Lieu / adresse<input value={lieu} disabled={!edit} onChange={(e) => setLieu(e.target.value)} placeholder="Facultatif" className={CHAMP} /></label>
        {p.mode === "INDIVIDUAL" && <div className="sm:col-span-2"><ChampMontant scope={scope} kind={c.serviceKind} taux={p.taux} valeur={montant} onChange={setMontant} id={`m-${c.id}`} /></div>}
        {canEdit && !c.expenseOrderId && (
          <label className={ETIQUETTE}>État
            <select value={c.status} disabled={busy !== null} onChange={(e) => void run(`cs:${c.id}`, () => setCareCellStatus(undefined, fd({ id: c.id, status: e.target.value })), "État mis à jour.")} className={CHAMP}>
              {(["REQUESTED", "PROVIDED", "SETTLED", "WAIVED"] as CareCellStatus[]).map((s) => <option key={s} value={s}>{CELL_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
        )}
      </div>
      <DevisDuPoste c={c} quotes={p.quotes} canEdit={canEdit} busy={busy} run={run} />
      {edit && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={enregistrer}>{busy === `pa:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Enregistrer</Button>
          <RetirerPoste c={c} busy={busy} run={run} />
        </div>
      )}
    </div>
  );
}

function RetirerPoste({ c, busy, run }: { c: CellRow; busy: string | null; run: Run }) {
  if (c.expenseOrderId) return null;
  return (
    <Button type="button" size="sm" variant="ghost" disabled={busy !== null}
      onClick={() => { if (window.confirm(`Retirer « ${c.label} » de la fiche ?`)) void run(`cd:${c.id}`, () => removeCareCell(undefined, fd({ id: c.id })), "Poste retiré."); }}>
      <Trash2 className="h-4 w-4" /> Retirer
    </Button>
  );
}

/**
 * LE BILLET ÉMIS / LA CONFIRMATION D'HÔTEL (Direction, 10/2026) — l'e-billet ou le voucher, la référence (PNR,
 * n° de confirmation) et, pour un billet, le n° de vol / train et les heures de CHAQUE trajet : le livret de séjour
 * les lira. Ouvert à l'assistante de direction, au demandeur, à la Direction Marketing et au Super Admin.
 */
export function BilletEmis({ c, busy, run }: { c: CellRow; busy: string | null; run: Run }) {
  const billet = c.serviceKind === "TICKET";
  const trajets = billet ? etapesDuBillet(c) : [];
  const [ouvert, setOuvert] = React.useState(false);
  const [ref, setRef] = React.useState(c.bookingRef ?? "");
  const [details, setDetails] = React.useState<DetailTrajet[]>(trajets.map((_, i) => c.legDetails[i] ?? { numero: null, heureDepart: null, heureArrivee: null, reference: null }));
  const fichier = React.useRef<HTMLInputElement>(null);
  const maj = (i: number, k: keyof DetailTrajet, v: string) => setDetails((l) => l.map((x, j) => (j === i ? { ...x, [k]: v || null } : x)));
  const titre = billet ? "Billet émis" : "Confirmation d'hôtel";
  if (!ouvert) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs">
        <span className="font-medium">{titre}</span>
        {c.issuedDocumentId ? <a href={`/api/documents/${c.issuedDocumentId}`} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">voir le fichier</a> : <span className="text-muted-foreground">pas encore déposé</span>}
        {c.bookingRef && <span className="text-muted-foreground">réf. {c.bookingRef}</span>}
        <button type="button" className="ml-auto font-medium text-primary hover:underline" onClick={() => setOuvert(true)}>{c.issuedDocumentId || c.bookingRef ? "modifier" : "déposer"}</button>
      </div>
    );
  }
  return (
    <form
      className="space-y-2 rounded-lg border border-border p-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData();
        f.set("id", c.id);
        f.set("bookingRef", ref);
        if (billet) f.set("legDetails", JSON.stringify(details));
        const file = fichier.current?.files?.[0];
        if (file) f.set("file", file);
        void run(`be:${c.id}`, () => enregistrerBilletEmis(undefined, f)).then(() => setOuvert(false));
      }}
    >
      <p className="flex items-center gap-1 font-medium">{titre}
        <InfoBulle label="À quoi ça sert ?">Ces informations alimentent le livret de séjour remis à la personne.</InfoBulle>
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className={ETIQUETTE}>{billet ? "E-billet (PDF)" : "Voucher (PDF)"}<input ref={fichier} type="file" accept="application/pdf,image/*" className="mt-1 block w-full text-xs" /></label>
        <label className={ETIQUETTE}>{billet ? "Référence de réservation (PNR)" : "N° de confirmation"}<input value={ref} onChange={(e) => setRef(e.target.value)} className={CHAMP} /></label>
      </div>
      {trajets.map((t, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded-md bg-secondary/40 p-2 sm:grid-cols-4">
          <p className="font-medium sm:col-span-4">{t.de ?? "?"} → {t.vers ?? "?"}{t.date ? ` · ${t.date.split("-").reverse().join("/")}` : ""}</p>
          <label className={ETIQUETTE}>N° de vol / train<input value={details[i]?.numero ?? ""} onChange={(e) => maj(i, "numero", e.target.value)} placeholder="AH 1006" className={CHAMP} /></label>
          <label className={ETIQUETTE}>Départ<input type="time" value={details[i]?.heureDepart ?? ""} onChange={(e) => maj(i, "heureDepart", e.target.value)} className={CHAMP} /></label>
          <label className={ETIQUETTE}>Arrivée<input type="time" value={details[i]?.heureArrivee ?? ""} onChange={(e) => maj(i, "heureArrivee", e.target.value)} className={CHAMP} /></label>
          <label className={ETIQUETTE}>Référence<input value={details[i]?.reference ?? ""} onChange={(e) => maj(i, "reference", e.target.value)} placeholder="PNR du trajet" className={CHAMP} /></label>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy !== null}>{busy === `be:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOuvert(false)}>Annuler</Button>
      </div>
    </form>
  );
}
