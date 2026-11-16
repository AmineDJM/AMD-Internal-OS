"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatCurrency } from "@/lib/utils";
import { PAYMENT_REQUEST_STATUS } from "@/lib/labels";
import {
  dateDeLaDemande, deplacerDansMonOrdre, LIBELLE_TRI, mettreEnTeteDeMonOrdre, TRIS_MES_DEMANDES, trierMesDemandes, type LigneMaDemande, type TriMesDemandes,
} from "@/modules/finances/partage";
import { ordonnerMesDemandesDePaiement } from "@/modules/finances/actions-pieces-paiement";
import { useTriMesDemandes } from "./tri-mes-demandes";

/**
 * « MES DEMANDES » DE PAIEMENT, TRIABLES (Direction, 10/11/2026) — la plus récente en tête par défaut ; « Trier par »
 * propose les autres ordres, et « Ma priorité » laisse la personne ranger SES demandes (↑ / ↓, gardé en base, vu d'elle
 * seule). Le choix du tri est retenu dans ce navigateur. Deux formes : le tableau de /validations/paiements, la liste
 * de /validations.
 */
export function ListeMesDemandes({ lignes: depart, forme }: { lignes: LigneMaDemande[]; forme: "tableau" | "liste" }) {
  const [tri, setTri] = useTriMesDemandes();
  const [lignes, setLignes] = React.useState(depart);
  const [erreur, setErreur] = React.useState<string | null>(null);
  React.useEffect(() => { setLignes(depart); }, [depart]);
  const triees = trierMesDemandes(lignes, tri);
  const ranger = tri === "MA_PRIORITE";

  const enregistrer = (ordre: string[] | null) => {
    if (!ordre) return;
    const avant = lignes;
    const place = new Map(ordre.map((x, i) => [x, i]));
    setLignes(lignes.map((l) => ({ ...l, rang: place.get(l.id) ?? l.rang })));
    setErreur(null);
    void ordonnerMesDemandesDePaiement(ordre)
      .then((r) => { if (!r.ok) { setLignes(avant); setErreur(r.error ?? "L'ordre n'a pas été gardé."); } })
      .catch(() => { setLignes(avant); setErreur("L'ordre n'a pas été gardé : réessayez."); });
  };

  const deplacer = (id: string, sens: -1 | 1) => enregistrer(deplacerDansMonOrdre(lignes, id, sens));

  const fleches = (l: LigneMaDemande, i: number) => (
    <span className="inline-flex shrink-0 gap-0.5">
      <button type="button" onClick={() => enregistrer(mettreEnTeteDeMonOrdre(lignes, l.id))} disabled={i === 0}
        aria-label={`Mettre ${l.reference} en tête`} title="Mettre en tête"
        className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ChevronsUp className="h-3.5 w-3.5" /></button>
      <button type="button" onClick={() => deplacer(l.id, -1)} disabled={i === 0} aria-label={`Monter ${l.reference}`}
        className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
      <button type="button" onClick={() => deplacer(l.id, 1)} disabled={i === triees.length - 1} aria-label={`Descendre ${l.reference}`}
        className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
    </span>
  );

  return (
    <div className="space-y-2">
      <MenuDeTri tri={tri} onChange={setTri} />
      {ranger && <p className="text-xs text-muted-foreground">Rangez vos demandes avec ↑ / ↓, ou mettez-en une en tête (⇈) : l&apos;ordre est gardé, et personne d&apos;autre ne le voit.</p>}
      {erreur && <p className="text-xs text-destructive">{erreur}</p>}
      {forme === "tableau" ? (
        <div className="surface overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {ranger && <TableHead className="w-24"><span className="sr-only">Ordre</span></TableHead>}
                <TableHead>Référence</TableHead>
                <TableHead>Demandée le</TableHead>
                <TableHead>Objet</TableHead>
                <TableHead>Bénéficiaire</TableHead>
                <TableHead className="text-right">Montant</TableHead>
                <TableHead>Échéance</TableHead>
                <TableHead>État</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {triees.map((l, i) => (
                <TableRow key={l.id}>
                  {ranger && <TableCell>{fleches(l, i)}</TableCell>}
                  <TableCell className="font-mono text-xs">
                    <Link href={`/validations/paiements/${l.id}`} className="hover:underline">{l.reference}</Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{dateDeLaDemande(l.creeLe)}</TableCell>
                  <TableCell className="font-medium [overflow-wrap:anywhere]">
                    <Link href={`/validations/paiements/${l.id}`} className="hover:underline">{l.titre}</Link>
                    {l.compagnon && <span className="block text-xs font-normal text-muted-foreground">accompagne un ordre de dépense</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.beneficiaire}</TableCell>
                  <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums sm:font-normal">{formatCurrency(l.montant)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {l.echeance}
                    {l.enRetard && <Badge tone="danger" dot={false} className="ml-1.5">en retard</Badge>}
                    {l.nature && <span className={l.natureFixe ? "block text-xs font-semibold text-destructive" : "block text-xs"}>{l.nature}</span>}
                  </TableCell>
                  <TableCell><StatusBadge map={PAYMENT_REQUEST_STATUS} value={l.statut} dot={false} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="surface divide-y divide-border p-0">
          {triees.map((l, i) => (
            <div key={l.id} className="flex items-center gap-1 pl-1">
              {ranger && fleches(l, i)}
              <Link
                href={`/validations/paiements/${l.id}`}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2.5 text-sm hover:bg-secondary/40"
              >
                <span className="font-mono text-xs text-muted-foreground">{l.reference}</span>
                <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums" title="Date de la demande">{dateDeLaDemande(l.creeLe)}</span>
                <span className="w-full min-w-0 truncate font-medium sm:w-auto sm:flex-1">{l.titre}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{l.beneficiaire}</span>
                <span className="whitespace-nowrap font-semibold tabular-nums">{formatCurrency(l.montant)}</span>
                <span className="text-xs text-muted-foreground">
                  {l.echeance}
                  {l.enRetard && <Badge tone="danger" dot={false} className="ml-1.5">en retard</Badge>}
                </span>
                <StatusBadge map={PAYMENT_REQUEST_STATUS} value={l.statut} dot={false} />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Le menu « Trier par » — le même pour les trois listes. */
export function MenuDeTri({ tri, onChange, sans = [] }: { tri: TriMesDemandes; onChange: (t: TriMesDemandes) => void; sans?: TriMesDemandes[] }) {
  return (
    <label className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      Trier par
      <Select value={tri} onChange={(e) => onChange(e.target.value as TriMesDemandes)} className="h-8 w-auto text-xs" aria-label="Trier mes demandes">
        {TRIS_MES_DEMANDES.filter((t) => !sans.includes(t)).map((t) => <option key={t} value={t}>{LIBELLE_TRI[t]}</option>)}
      </Select>
    </label>
  );
}
