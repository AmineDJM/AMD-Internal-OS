"use client";

import * as React from "react";
import { Check, Clock, X, Hand, Mail, Copy, Building2, FileSignature, Send, ShieldCheck, PackageCheck, Receipt, Search, ExternalLink, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { FormulaireSignature } from "@/components/signature/formulaire-signature";
import type { SignaturePrete } from "@/lib/signature-en-ligne/partage";
import { friseAgence, pasAgence, type FaitsPosteAgence, type GesteAgence, type RegardAgence } from "../../domaine/parcours-agence";
import { demanderProspection, transmettreDevisAgences, choisirAgencePoste, soumettreBcMarketing, validerSignerBcMarketing, signerBcMarketing } from "../../actions-postes-agence";
import { marquerBcEnvoye, envoyerBatConformite, deciderConformitePoste, signerReceptionPoste } from "../../actions-postes-execution";
import { preparerBrouillonPoste } from "../../actions-postes-lignes";
import { lienFichierEmis } from "@/lib/lecteurs/fichiers-emis";
import { emailDeProspection } from "../../domaine/email-prospection";
import type { ItemRow, Run } from "../items-panel";

/** Les gestes dont le formulaire vit AILLEURS sur la carte (la case des devis, le visa, la facture) : la carte les ouvre. */
export type GesteDelegue = "DEVIS" | "VISER_BC" | "DEMANDER_PAIEMENT" | "BC";

const ICONE: Record<GesteAgence, React.ReactNode> = {
  DEMANDER_PROSPECTION: <Search className="h-4 w-4" />, DEPOSER_DEVIS: <Building2 className="h-4 w-4" />, CHOISIR_AGENCE: <Hand className="h-4 w-4" />,
  PREPARER_BC: <FileSignature className="h-4 w-4" />, FINALISER_BC: <FileSignature className="h-4 w-4" />, VALIDER_SIGNER_BC: <ShieldCheck className="h-4 w-4" />,
  SIGNER_BC_MARKETING: <ShieldCheck className="h-4 w-4" />, VISER_BC: <BadgeCheck className="h-4 w-4" />, ENVOYER_BC: <Send className="h-4 w-4" />,
  ENVOYER_BAT: <Send className="h-4 w-4" />, CONTROLER_BAT: <ShieldCheck className="h-4 w-4" />, SIGNER_RECEPTION: <PackageCheck className="h-4 w-4" />,
  DEPOSER_FACTURE: <Receipt className="h-4 w-4" />,
};

/** Les faits du parcours tels que la carte les lit — une seule traduction, celle de l'écran. */
export function faitsAgenceDuPoste(item: ItemRow): FaitsPosteAgence | null {
  if (!item.agence) return null;
  return {
    status: item.status, orderStage: item.orderStage,
    bc: item.pieces.bc ? (item.pieces.bc.etape ?? "HORS_CIRCUIT") : null,
    factures: item.pieces.factures.length, expenseOrderId: item.expenseOrderId,
    expenseOrderStatus: item.expenseOrder?.status ?? null, expenseOrderCentral: item.expenseOrder?.centralStatus ?? null,
    agence: item.agence.faits,
  };
}

/** Le total d'un devis tel que le comparatif le montre — TTC quand la TVA est imprimée, HT sinon (jamais devinée). */
function totalDuDevis(d: ItemRow["devisLignes"][number]): { montant: number; ttc: boolean } {
  if (d.entete.announcedTotal != null) return { montant: d.entete.announcedTotal, ttc: d.entete.tvaRate != null };
  const taux = (d.entete.tvaRate ?? 0) + (d.entete.extraTaxRate ?? 0);
  return { montant: Math.round(d.totalDevisHt * (1 + taux / 100) * 100) / 100, ttc: d.entete.tvaRate != null };
}

/** LA FRISE — sept étapes, l'étape en cours nommée en clair. */
function Frise({ faits }: { faits: FaitsPosteAgence }) {
  const etapes = friseAgence(faits);
  return (
    <ol className="flex w-full items-center gap-1 overflow-x-auto pb-1" aria-label="Étapes du poste">
      {etapes.map((e, i) => (
        <li
          key={e.cle} title={e.libelle} aria-current={e.etat === "EN_COURS" ? "step" : undefined}
          // L'étape EN COURS se lit en entier ; les autres se resserrent (libellé complet au survol).
          className={cn("flex items-center gap-1", e.etat === "EN_COURS" ? "flex-none" : "min-w-0 flex-1")}
        >
          <span className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
            e.etat === "FAIT" && "border-success bg-success text-success-foreground",
            e.etat === "EN_COURS" && "border-primary bg-primary text-primary-foreground ring-2 ring-primary/25",
            e.etat === "REFUSE" && "border-destructive bg-destructive text-destructive-foreground",
            e.etat === "A_VENIR" && "border-border bg-card text-muted-foreground",
          )}>
            {e.etat === "FAIT" ? <Check className="h-3.5 w-3.5" /> : e.etat === "REFUSE" ? <X className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span className={cn("text-[11px]", e.etat === "EN_COURS" ? "whitespace-nowrap font-semibold text-foreground" : "truncate text-muted-foreground")}>{e.libelle}</span>
          {i < etapes.length - 1 && <span aria-hidden className={cn("h-px min-w-2 flex-1", e.etat === "FAIT" ? "bg-success" : "bg-border")} />}
        </li>
      ))}
    </ol>
  );
}

/** L'E-MAIL AUX AGENCES, prêt à copier : l'objet, le corps, ou les deux d'un coup (16/11/2026). */
function EmailAuxAgences({ email }: { email: { objet: string; corps: string } }) {
  const [copie, setCopie] = React.useState<string | null>(null);
  const copier = (cle: string, texte: string) => {
    void navigator.clipboard?.writeText(texte).then(() => { setCopie(cle); setTimeout(() => setCopie(null), 1500); }).catch(() => setCopie(null));
  };
  const bouton = (cle: string, libelle: string, texte: string) => (
    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => copier(cle, texte)}>
      {copie === cle ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />} {copie === cle ? "Copié" : libelle}
    </Button>
  );
  return (
    <div className="space-y-2 rounded-lg border bg-card p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs"><span className="text-muted-foreground">Objet :</span> <span className="font-medium">{email.objet}</span></p>
        {bouton("objet", "Copier l'objet", email.objet)}
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2.5 font-sans text-xs leading-relaxed">{email.corps}</pre>
      <div className="flex flex-wrap justify-end gap-1">
        {bouton("corps", "Copier le texte", email.corps)}
        {bouton("tout", "Tout copier", `Objet : ${email.objet}

${email.corps}`)}
      </div>
    </div>
  );
}

export function ParcoursAgence({ item, regard, assistantes, budgetOptions, signature, busy, run, ouvrir }: {
  item: ItemRow;
  regard: RegardAgence;
  assistantes: { id: string; name: string }[];
  budgetOptions: { id: string; label: string }[];
  signature: SignaturePrete;
  busy: string | null;
  run: Run;
  /** Ouvre un formulaire qui vit ailleurs sur la carte. */
  ouvrir: (g: GesteDelegue) => void;
}) {
  const faits = faitsAgenceDuPoste(item);
  const [ouvert, setOuvert] = React.useState<GesteAgence | null>(null);
  const [devisChoisi, setDevisChoisi] = React.useState<string>("");
  const [emailOuvert, setEmailOuvert] = React.useState(false);
  if (!faits || !item.agence) return null;
  const a = item.agence;
  const pas = pasAgence(faits, regard);
  const enCours = busy !== null && busy.endsWith(`:${item.id}`);
  const fd = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("id", item.id);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  const fermer = () => setOuvert(null);
  const agir = (g: GesteAgence) => {
    if (g === "DEPOSER_DEVIS") return ouvrir("DEVIS");
    if (g === "VISER_BC") return ouvrir("VISER_BC");
    if (g === "DEPOSER_FACTURE") return ouvrir("DEMANDER_PAIEMENT");
    if (g === "PREPARER_BC") return void run(`agp:${item.id}`, () => preparerBrouillonPoste(fd()), "BC préparé.");
    if (g === "FINALISER_BC") ouvrir("BC");
    setOuvert((o) => (o === g ? null : g));
  };
  const devis = item.devisLignes.filter((d) => !d.annule);
  const pdfBc = a.bcId ? lienFichierEmis(a.bcId, "pdf") : null;

  return (
    <section className="space-y-2.5" aria-label="Parcours agence du poste">
      <Frise faits={faits} />

      {/* À VOUS — un seul bouton ; sinon CHEZ QUI en est le poste. */}
      {pas.geste ? (
        <Button size="sm" className="w-full sm:w-auto" onClick={() => agir(pas.geste!.cle)} disabled={enCours}>{ICONE[pas.geste.cle]} {pas.geste.libelle}</Button>
      ) : pas.attente ? (
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><Clock className="mt-0.5 h-4 w-4 shrink-0" /> <span>{pas.attente}</span></p>
      ) : null}

      {a.cahierDesCharges && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground"><span className="font-medium text-foreground">Cahier des charges :</span> {a.cahierDesCharges}</p>
            {!faits.agence.agenceRetenue && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEmailOuvert((o) => !o)}>
                <Mail className="h-3.5 w-3.5" /> {emailOuvert ? "Masquer l'e-mail" : "Générer l'e-mail"}
              </Button>
            )}
          </div>
          {emailOuvert && !faits.agence.agenceRetenue && (
            <EmailAuxAgences email={emailDeProspection({ poste: item.label, cahierDesCharges: a.cahierDesCharges, evenement: a.evenement ?? null, signataire: faits.agence.assistante })} />
          )}
        </div>
      )}
      {a.agenceNom && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Agence retenue :</span> {a.agenceNom}</p>}
      {a.conformiteNote && faits.agence.conformite === "NON_CONFORME" && <p className="rounded-md bg-warning/10 px-2.5 py-1.5 text-xs"><strong>Non conforme :</strong> {a.conformiteNote}</p>}

      {/* DEMANDER LA PROSPECTION */}
      {ouvert === "DEMANDER_PROSPECTION" && (
        <form className="space-y-2 rounded-lg border border-border bg-card p-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          f.set("id", item.id);
          void run(`agd:${item.id}`, () => demanderProspection(f), "Prospection demandée.").then(fermer);
        }}>
          <div className="space-y-1">
            <Label htmlFor={`agd-ass-${item.id}`}>Assistante de direction</Label>
            <select id={`agd-ass-${item.id}`} name="assistanteId" required className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">
              <option value="">Choisir…</option>
              {assistantes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`agd-cdc-${item.id}`}>Ce qu&apos;il faut commander</Label>
            <Textarea id={`agd-cdc-${item.id}`} name="cahierDesCharges" required rows={3} placeholder="Ex. : stand 9 m² avec comptoir, 4 kakémonos, livraison sur site le 11/12." />
          </div>
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={enCours}>Envoyer à l&apos;assistante</Button><Button size="sm" type="button" variant="ghost" onClick={fermer}>Annuler</Button></div>
        </form>
      )}

      {/* L'ASSISTANTE TRANSMET LES DEVIS — visible pour elle dès qu'un devis est déposé. */}
      {pas.geste?.cle === "DEPOSER_DEVIS" && devis.length > 0 && (
        <form className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-sm" onSubmit={(e) => {
          e.preventDefault();
          const ok = (e.currentTarget.elements.namedItem("compare") as HTMLInputElement).checked;
          void run(`agt:${item.id}`, () => transmettreDevisAgences(fd({ compare: ok ? "oui" : "non" })), "Devis transmis.");
        }}>
          <span className="font-medium">{devis.length} devis déposé{devis.length > 1 ? "s" : ""}{devis.length < 3 ? " (3 conseillés)" : ""}</span>
          <label className="flex items-center gap-1.5 text-xs"><input id={`agt-cmp-${item.id}`} name="compare" type="checkbox" className="h-4 w-4" /> J&apos;ai comparé les lignes de chaque devis au papier</label>
          <Button size="sm" type="submit" disabled={enCours}><Send className="h-4 w-4" /> Transmettre à la Direction Marketing</Button>
        </form>
      )}

      {/* LE COMPARATIF — la Direction Marketing choisit l'agence et le budget. */}
      {ouvert === "CHOISIR_AGENCE" && (
        <form className="space-y-2 rounded-lg border border-border bg-card p-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          f.set("id", item.id);
          void run(`agc:${item.id}`, () => choisirAgencePoste(f), "Agence retenue.").then(fermer);
        }}>
          <p className="text-sm font-semibold">Comparer les devis</p>
          <div className="space-y-1.5">
            {devis.map((d) => {
              const t = totalDuDevis(d);
              return (
                <label key={d.pieceId} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-sm", devisChoisi === d.pieceId ? "border-primary bg-primary/5" : "border-border")}>
                  <input type="radio" name="pieceId" value={d.pieceId} checked={devisChoisi === d.pieceId} onChange={() => setDevisChoisi(d.pieceId)} className="h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{d.fournisseur ?? d.titre}</span>
                    <span className="block text-xs text-muted-foreground">{d.reference ?? d.titre} · {d.lignes.length} ligne{d.lignes.length > 1 ? "s" : ""}</span>
                  </span>
                  <span className="text-right tabular-nums font-semibold">{formatCurrency(t.montant)}<span className="block text-[10px] font-normal text-muted-foreground">{t.ttc ? "TTC" : "HT, sans TVA"}</span></span>
                  {d.fichierId && <a href={`/api/documents/${d.fichierId}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary" aria-label="Ouvrir le devis"><ExternalLink className="h-4 w-4" /></a>}
                </label>
              );
            })}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`agc-bud-${item.id}`}>Budget qui porte ce poste</Label>
            <select id={`agc-bud-${item.id}`} name="budgetCategoryId" required defaultValue={item.budgetCategoryId ?? ""} className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">
              <option value="">Choisir le budget (enveloppe › catégorie)…</option>
              {budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">Le montant accordé est celui du devis retenu. Les autres devis sont marqués « non retenus ».</p>
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={!devisChoisi || enCours}>Retenir cette agence</Button><Button size="sm" type="button" variant="ghost" onClick={fermer}>Annuler</Button></div>
        </form>
      )}

      {/* L'ASSISTANTE SOUMET LE BC FINALISÉ */}
      {pas.geste?.cle === "FINALISER_BC" && faits.agence.brouillonBc && !faits.agence.bcSoumis && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-sm">
          <span>Corrigez le BC dans la case « Bon de commande » ci-dessous, puis :</span>
          <Button size="sm" onClick={() => void run(`ags:${item.id}`, () => soumettreBcMarketing(fd()), "BC soumis.")} disabled={enCours}><Send className="h-4 w-4" /> Soumettre à la Direction Marketing</Button>
        </div>
      )}

      {/* LA DIRECTION MARKETING VALIDE, SIGNE ET CACHETTE */}
      {(ouvert === "VALIDER_SIGNER_BC" || ouvert === "SIGNER_BC_MARKETING") && (
        <FormulaireSignature
          titre={ouvert === "VALIDER_SIGNER_BC" ? "Valider, signer et cacheter le bon de commande" : "Signer et cacheter le bon de commande"}
          bouton={ouvert === "VALIDER_SIGNER_BC" ? "Valider, signer et cacheter" : "Signer et cacheter"}
          pret={signature} apercu={pdfBc} busy={enCours} onCancel={fermer}
          onSigner={(f) => {
            f.set("id", item.id);
            void run(`agv:${item.id}`, () => (ouvert === "VALIDER_SIGNER_BC" ? validerSignerBcMarketing(f) : signerBcMarketing(f)), "BC signé et cacheté.").then(fermer);
          }}
        />
      )}

      {ouvert === "ENVOYER_BC" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-sm">
          {pdfBc && <a href={lienFichierEmis(a.bcId!, "pdf", true)} className="font-medium text-primary hover:underline">Télécharger le BC signé</a>}
          <Button size="sm" onClick={() => void run(`age:${item.id}`, () => marquerBcEnvoye(fd()), "BC envoyé.").then(fermer)} disabled={enCours}><Send className="h-4 w-4" /> C&apos;est envoyé à l&apos;agence</Button>
        </div>
      )}

      {ouvert === "ENVOYER_BAT" && (
        <form className="space-y-2 rounded-lg border border-border bg-card p-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          f.set("id", item.id);
          void run(`agb:${item.id}`, () => envoyerBatConformite(f), "BAT transmis.").then(fermer);
        }}>
          <Label htmlFor={`agb-${item.id}`}>BAT de l&apos;agence (PDF ou image)</Label>
          <Input id={`agb-${item.id}`} name="bat" type="file" multiple accept=".pdf,image/*" required />
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={enCours}>Transmettre à l&apos;information médicale</Button><Button size="sm" type="button" variant="ghost" onClick={fermer}>Annuler</Button></div>
        </form>
      )}

      {ouvert === "CONTROLER_BAT" && (
        <form className="space-y-2 rounded-lg border border-border bg-card p-3" onSubmit={(e) => e.preventDefault()}>
          {a.bat && <a href={`/api/documents/${a.bat.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"><ExternalLink className="h-4 w-4" /> {a.bat.nom}</a>}
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>Mentions légales et RCP conformes</li><li>N° de visa publicitaire présent</li><li>Aucune allégation hors AMM</li><li>Logo et dénomination conformes</li>
          </ul>
          <Label htmlFor={`agk-note-${item.id}`}>Ce qu&apos;il faut corriger (obligatoire si non conforme)</Label>
          <Textarea id={`agk-note-${item.id}`} name="note" rows={2} />
          <div className="flex flex-wrap gap-2">
            {(["CONFORME", "NON_CONFORME"] as const).map((d) => (
              <Button key={d} size="sm" variant={d === "CONFORME" ? "success" : "destructive"} disabled={enCours} onClick={(e) => {
                const note = ((e.currentTarget.form?.elements.namedItem("note") as HTMLTextAreaElement | null)?.value ?? "").trim();
                void run(`agk:${item.id}`, () => deciderConformitePoste(fd({ decision: d, ...(note ? { note } : {}) })), d === "CONFORME" ? "Conforme." : "Non conforme.").then(fermer);
              }}>{d === "CONFORME" ? "Conforme" : "Non conforme"}</Button>
            ))}
          </div>
        </form>
      )}

      {ouvert === "SIGNER_RECEPTION" && (
        <form className="space-y-2 rounded-lg border border-border bg-card p-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          f.set("id", item.id);
          f.set("reserve", (e.currentTarget.elements.namedItem("reserveCase") as HTMLInputElement).checked ? "oui" : "non");
          void run(`agr:${item.id}`, () => signerReceptionPoste(f), "Réception signée.").then(fermer);
        }}>
          <p className="text-sm font-semibold">PV de réception</p>
          <Label htmlFor={`agr-note-${item.id}`}>Ce qui a été reçu (facultatif)</Label>
          <Textarea id={`agr-note-${item.id}`} name="note" rows={2} placeholder="Ex. : stand monté le 11/12, 4 kakémonos, 2 000 brochures." />
          <label className="flex items-center gap-2 text-sm"><input id={`agr-res-${item.id}`} name="reserveCase" type="checkbox" className="h-4 w-4" /> Réception avec réserve (manque, article abîmé…)</label>
          <Label htmlFor={`agr-ph-${item.id}`}>Photos (facultatif)</Label>
          <Input id={`agr-ph-${item.id}`} name="photos" type="file" multiple accept="image/*,.pdf" />
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={enCours}>Signer le PV de réception</Button><Button size="sm" type="button" variant="ghost" onClick={fermer}>Annuler</Button></div>
        </form>
      )}

      {/* LES SIGNATURES DU BC — qui, quand, et la page de vérification. */}
      {a.signatures.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {a.signatures.map((s) => (
            <li key={s.jeton} className="flex flex-wrap items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-success" />
              Signé et cacheté par <span className="font-medium text-foreground">{s.nom}</span> ({s.qualite === "FINANCES" ? "Finances" : "Direction Marketing"}) le {formatDate(s.le)}
              <a href={`/verifier-bc/${s.jeton}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">Vérifier</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
