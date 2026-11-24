"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { cn } from "@/lib/utils";
import { formatDzd, lireMontantFiscal } from "../../domaine/impots";
import { envoyerPaiementPonctuel } from "../../actions-impots";
import { champ, EnTetePanneau, Note, nomSociete, Pastille, type Annoncer, type Ligne, type Societe } from "./commun";

/**
 * UN PAIEMENT PONCTUEL — hors calendrier (taxe foncière, pénalité, régularisation…) : un organisme, la société qui paie,
 * une nature, une période, le montant TEL QUE SUR LE JUSTIFICATIF, et le justificatif. Avec une ligne ponctuelle reprise
 * après un refus, le même formulaire la corrige et la renvoie.
 */
export function PanneauPonctuel({ ligne, organismesConnus, societes, societeParDefaut, peutCreer, peutModifier, onFermer, onEnvoye, annoncer }: {
  ligne: Ligne | null; organismesConnus: string[]; societes: Societe[]; societeParDefaut: string | null;
  peutCreer: boolean; peutModifier: boolean; onFermer: () => void; onEnvoye: (id: string | undefined) => void; annoncer: Annoncer;
}) {
  const { busy, err, setErr, run } = useAction();
  const [organisme, setOrganisme] = React.useState(ligne?.organisme ?? organismesConnus[0] ?? "");
  const [companyId, setCompanyId] = React.useState(ligne?.companyId ?? societeParDefaut ?? societes[0]?.id ?? "");
  const [nature, setNature] = React.useState(ligne?.nature ?? "");
  const [periode, setPeriode] = React.useState(ligne && ligne.periodeLibelle !== "—" ? ligne.periodeLibelle : "");
  const [montant, setMontant] = React.useState(ligne?.saisies.montant ?? (ligne?.montant ? formatDzd(ligne.montant) : ""));
  const [fichier, setFichier] = React.useState<File | null>(null);
  const permis = ligne ? peutModifier : peutCreer;
  const connus = organisme && !organismesConnus.includes(organisme) ? [...organismesConnus, organisme] : organismesConnus;

  const envoyer = () => run(async () => {
    const fd = new FormData();
    if (ligne) fd.set("id", ligne.id);
    fd.set("organisme", organisme);
    fd.set("companyId", companyId);
    fd.set("nature", nature);
    fd.set("periode", periode);
    fd.set("montant", montant);
    if (fichier) fd.set("justificatif", fichier);
    const r = await envoyerPaiementPonctuel(fd);
    if (r.ok) { if (r.message) annoncer(r.message); onEnvoye(r.id); }
    return r;
  });

  return (
    <div className="flex flex-col gap-3.5">
      <EnTetePanneau surtitre="Hors calendrier · saisi par les Finances" titre={ligne ? "Corriger et renvoyer" : "Ajouter un paiement ponctuel"} onFermer={onFermer} />
      {ligne?.motifRefusPrecedent && <Note ton="refus"><strong>Refusé la première fois :</strong> {ligne.motifRefusPrecedent}</Note>}

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-semibold text-muted-foreground">Organisme</p>
        <div className="flex flex-wrap gap-1.5">
          {connus.map((o) => <Pastille key={o} actif={organisme === o} disabled={!permis} onClick={() => setOrganisme(o)}>{o}</Pastille>)}
          <input type="text" aria-label="Autre organisme" placeholder="Autre organisme" disabled={!permis}
            value={connus.includes(organisme) ? "" : organisme} onChange={(e) => setOrganisme(e.target.value)} className={cn(champ, "h-9 w-48 rounded-full")} />
        </div>
      </div>

      {societes.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold text-muted-foreground">Société qui paie</p>
          <div className="flex flex-wrap gap-1.5">
            {societes.map((s) => <Pastille key={s.id} actif={companyId === s.id} disabled={!permis} onClick={() => setCompanyId(s.id)}>{nomSociete(s)}</Pastille>)}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm font-semibold text-muted-foreground">Nature
          <input type="text" value={nature} onChange={(e) => setNature(e.target.value)} disabled={!permis} placeholder="ex. Taxe foncière — entrepôt" className={champ} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-muted-foreground">Période
          <input type="text" value={periode} onChange={(e) => setPeriode(e.target.value)} disabled={!permis} placeholder="ex. année 2026" className={champ} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-muted-foreground">Montant (DZD), tel que sur le justificatif
          <input type="text" inputMode="decimal" value={montant} onChange={(e) => { setMontant(e.target.value); setErr(null); }} disabled={!permis} placeholder="0"
            className={cn(champ, "text-right text-base font-semibold")} />
        </label>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border border-border px-3.5 py-3">
        <label htmlFor="pf-fichier" className="text-sm font-semibold">Justificatif — avis d&apos;imposition, bordereau ou lettre de l&apos;organisme <span className="text-destructive">* obligatoire</span></label>
        {fichier || ligne?.justificatif ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success/10 px-2.5 py-2 text-sm text-success">
            <span className="[overflow-wrap:anywhere]">✓ {fichier?.name ?? ligne?.justificatif?.nom} — joint</span>
            {permis && fichier && <button type="button" className="font-semibold text-destructive" onClick={() => setFichier(null)}>Retirer</button>}
          </div>
        ) : null}
        {permis && !fichier && (
          <input id="pf-fichier" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} className="max-w-full text-sm" />
        )}
      </div>
      <p className="text-xs text-muted-foreground">Rien n&apos;est calculé : le montant est celui que vous saisissez, sous votre nom, avec le justificatif.</p>

      <Retour>{err}</Retour>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3.5">
        <Button type="button" variant="outline" size="lg" onClick={onFermer}>Annuler</Button>
        {permis && (
          <BoutonDecisif type="button" size="lg" disabled={busy} onClick={() => void envoyer()}
            confirmation={`Envoyer ${formatDzd(lireMontantFiscal(montant) ?? 0)} DZD au centre de paiement`}>
            Envoyer au centre de paiement
          </BoutonDecisif>
        )}
      </div>
    </div>
  );
}
