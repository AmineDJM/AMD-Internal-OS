"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Loader2, X } from "lucide-react";
import type { CandidatRattachement, FactureCompta } from "@/modules/finances/api";
import { createPaymentRequest } from "@/modules/finances/actions-demandes";
import { joindreJustificatifEcriture } from "@/modules/finances/actions-comptabilite";
import { useAction, useKeyedAction } from "@/components/shared/use-action";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Retour } from "@/components/ui/retour";
import { cn, formatCurrency } from "@/lib/utils";
import type { DroitsCompta } from "./ecran-comptabilite";
import { dateCourte, dateLongue } from "./format";
import { BoutonPrincipal, BoutonSecondaire } from "./elements";

const ApercuUniversel = dynamic(() => import("@/components/documents/apercu-universel").then((m) => m.ApercuUniversel), {
  ssr: false,
  loading: () => <div className="flex min-h-[200px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</div>,
});

/**
 * LE PANNEAU D'UNE FACTURE DU REGISTRE (trouvée par la recherche) — son état de paiement, son aperçu, et, si rien ne la
 * paie encore : « Créer sa demande de paiement » (le chemin existant, `createPaymentRequest` avec la facture choisie
 * dans Legal → `createExpenseOrder` → centre de paiement) ou « Rattacher à un paiement fait » (une dépense déjà
 * partie, sans justificatif).
 */
export function PanneauFacture({ f, droits, onFermer, onOuvrirEcriture }: {
  f: FactureCompta & { candidats: CandidatRattachement[] }; droits: DroitsCompta; onFermer: () => void; onOuvrirEcriture: (id: string) => void;
}) {
  const [ouvert, setOuvert] = React.useState<null | "demande" | "rattacher">(null);
  const piece = f.pieces[0] ?? null;
  const nom = `${f.type} ${f.reference ?? f.titre}`;
  const statut = f.etat === "NON_PAYEE"
    ? `✕ Facture non payée — liée à aucun paiement${f.echeance ? ` · échéance ${dateCourte(f.echeance)}` : ""}`
    : f.etat === "NON_ENCAISSEE" ? "✕ Facture de vente non encaissée"
    : f.etat === "DEMANDEE" ? `… Paiement demandé${[f.ordreRef, ...f.demandes].filter(Boolean).length ? ` · ${[f.ordreRef, ...f.demandes].filter(Boolean).join(", ")}` : ""}`
    : `✓ ${f.etatLibelle}${f.ecriture ? ` · ${f.ecriture.reference}` : ""}`;

  return (
    <>
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p className="text-[13px] text-muted-foreground">{f.type} · {f.maison}</p>
          <h2 className="mt-1 text-[19px] font-bold [overflow-wrap:anywhere]">{f.reference ?? f.titre} · {f.tiers}</h2>
        </div>
        <button type="button" onClick={onFermer} aria-label="Fermer la facture" className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg border border-border">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="text-2xl font-bold tabular-nums">{f.montant !== null ? formatCurrency(f.montant) : "Montant non renseigné"}</p>
      <div className={cn("rounded-[10px] px-3 py-2.5 text-sm font-semibold",
        f.etat === "NON_PAYEE" || f.etat === "NON_ENCAISSEE" ? "bg-destructive/5 text-destructive" : f.etat === "DEMANDEE" ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>
        {statut}
      </div>
      {f.doublon && <div className="rounded-[10px] bg-warning/10 px-3 py-2.5 text-[13px] font-semibold text-warning">! {f.doublon}</div>}

      {piece ? (
        <div className="max-h-[320px] min-h-[200px] overflow-auto rounded-[10px] border border-border bg-muted/30 p-2">
          <ApercuUniversel key={piece.id} src={piece.href} name={piece.nom} mime={piece.mime} telechargement={piece.href.includes("?") ? piece.href : `${piece.href}?dl=1`} />
        </div>
      ) : (
        <p className="rounded-[10px] border border-border px-3 py-2.5 text-[13px] text-muted-foreground">
          Aucun fichier joint à cette facture : déposez-le depuis <Link href={`/legal/${f.id}`} className="font-semibold text-primary">sa fiche Legal</Link>.
        </p>
      )}
      <p className="text-xs text-muted-foreground">{nom} · {dateLongue(f.date)}</p>

      <div className="flex flex-wrap gap-1.5">
        {f.ecriture && <BoutonPrincipal onClick={() => onOuvrirEcriture(f.ecriture!.id)}>Ouvrir {f.ecriture.reference}</BoutonPrincipal>}
        {f.peutDemander && droits.demanderPaiement && (
          <BoutonPrincipal onClick={() => setOuvert((o) => (o === "demande" ? null : "demande"))} aria-expanded={ouvert === "demande"}>Créer sa demande de paiement</BoutonPrincipal>
        )}
        {f.peutRattacher && droits.modifier && (
          <BoutonSecondaire onClick={() => setOuvert((o) => (o === "rattacher" ? null : "rattacher"))} aria-expanded={ouvert === "rattacher"}>Rattacher à un paiement fait</BoutonSecondaire>
        )}
        {piece && <a href={piece.href.includes("?") ? piece.href : `${piece.href}?dl=1`} className="inline-flex h-[38px] items-center rounded-lg border border-border px-3.5 text-sm font-semibold">Télécharger</a>}
      </div>

      {ouvert === "demande" && <DemandeDePaiement f={f} onFin={() => setOuvert(null)} />}
      {ouvert === "rattacher" && <Rattacher f={f} onFin={() => setOuvert(null)} />}
    </>
  );
}

/**
 * LA DEMANDE DE PAIEMENT D'UNE FACTURE DU REGISTRE — le formulaire existant (`createPaymentRequest`), prérempli : l'objet,
 * le fournisseur, le montant, la facture choisie dans Legal. Ce qu'il exige reste exigé (le moyen de paiement déclaré,
 * le montant de la facture) ; l'ordre naît par `createExpenseOrder`, en attente du centre de paiement.
 */
function DemandeDePaiement({ f, onFin }: { f: FactureCompta; onFin: () => void }) {
  const [moyen, setMoyen] = React.useState(false);
  const [echeance, setEcheance] = React.useState(f.echeance ? f.echeance.slice(0, 10) : "");
  const act = useAction();
  if (f.montant === null) {
    return <p className="rounded-[10px] border border-warning/40 bg-warning/10 p-3 text-[13px] text-warning">Le montant de cette facture n&apos;est pas renseigné : complétez-le depuis <Link href={`/legal/${f.id}`} className="font-semibold underline">sa fiche Legal</Link>, puis créez la demande.</p>;
  }
  const envoyer = () => act.run(async () => {
    const fd = new FormData();
    fd.set("title", `${f.type} ${f.reference ?? f.titre}`.slice(0, 200));
    fd.set("payee", f.tiers === "—" ? "" : f.tiers);
    fd.set("amount", String(f.montant));
    fd.append("legalDocumentIds", f.id);
    fd.set("submit", "1");
    fd.set("paymentMethodStated", moyen ? "1" : "0");
    if (echeance) fd.set("dueDate", echeance);
    return createPaymentRequest(undefined, fd);
  }, onFin, { succes: `Demande de paiement créée pour ${f.reference ?? f.titre} : elle part au centre de paiement.` });
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-primary bg-primary/5 p-3.5">
      <h3 className="text-[15px] font-bold">Envoyer au centre de paiement ?</h3>
      <p className="text-[13px] text-muted-foreground">{f.tiers} · {formatCurrency(f.montant)} · {f.reference ?? f.titre} jointe</p>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" checked={moyen} onChange={(x) => setMoyen(x.target.checked)} className="mt-0.5 h-4 w-4" />
        Le moyen de paiement figure sur la facture (RIB, chèque, espèces)
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted-foreground">
        Échéance
        <input type="date" value={echeance} onChange={(x) => setEcheance(x.target.value)} className="h-9 rounded-lg border border-border bg-background px-2 text-sm font-normal text-foreground" />
      </label>
      <Retour ton="erreur">{act.err}</Retour>
      <div className="flex justify-end gap-2">
        <BoutonSecondaire onClick={onFin}>Annuler</BoutonSecondaire>
        <BoutonDecisif type="button" size="md" disabled={act.busy} onClick={envoyer} confirmation="Envoyer la demande au centre de paiement">Confirmer</BoutonDecisif>
      </div>
    </div>
  );
}

function Rattacher({ f, onFin }: { f: FactureCompta & { candidats: CandidatRattachement[] }; onFin: () => void }) {
  const act = useKeyedAction();
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border p-3.5">
      <h3 className="text-[15px] font-bold">Paiements sans justificatif</h3>
      {f.candidats.length === 0 && <p className="text-[13px] text-muted-foreground">Aucun paiement sans justificatif dans cette société.</p>}
      {f.candidats.map((k) => (
        <div key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-2">
          <span className="min-w-0 text-[13px]">
            <strong>{k.tiers}</strong> · {formatCurrency(k.montant)}<br />
            <span className="text-muted-foreground">{k.reference} · {dateCourte(k.date)}</span>
            {k.suggere && <><br /><span className="font-semibold text-success">Même fournisseur, même montant</span></>}
          </span>
          <button
            type="button" disabled={act.busy !== null}
            onClick={() => act.run(k.id, () => { const fd = new FormData(); fd.set("id", k.id); fd.set("factureId", f.id); return joindreJustificatifEcriture(fd); }, { succes: `${f.reference ?? f.titre} rattachée à ${k.reference}. Le paiement est justifié.` }).then((ok) => { if (ok) onFin(); })}
            className="h-8 rounded-lg border border-primary px-3 text-[13px] font-semibold text-primary disabled:opacity-50"
          >
            {act.busy === k.id ? "…" : "Rattacher"}
          </button>
        </div>
      ))}
      <Retour ton="erreur">{act.error}</Retour>
      <BoutonSecondaire onClick={onFin} className="self-end">Fermer</BoutonSecondaire>
    </div>
  );
}
