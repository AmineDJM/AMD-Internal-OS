import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { filtresDepuis, lecteursDuJournal, lireJournal, TAILLE_PAGE } from "@/modules/coffre/api-lecture";
import { champSensible, LIBELLE_MODELE, MODELES_SENSIBLES, estNatureCoffre, LIBELLE_NATURE, NATURES_COFFRE } from "@/modules/coffre/partage";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const MOTIFS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin", TITULAIRE: "La personne elle-même", RH: "RH", FINANCES: "Finances",
  PIECE_OFFICIELLE: "Pièce officielle", MODELE_IA: "Modèle d'IA (jamais)", NATURE_INCOMPATIBLE: "Nature incompatible",
  HORS_PERIMETRE: "Hors périmètre",
};

/**
 * ADMINISTRATION › ACCÈS AUX DONNÉES SENSIBLES — Super Admin seul (refonte V2-E). Chaque lecture du coffre,
 * accordée ou refusée : qui, quand, pour quel geste, la colonne de qui. Filtres dans l'adresse (formulaire GET).
 */
export default async function AccesDonneesSensiblesPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/mon-espace");

  const f = filtresDepuis(searchParams);
  const [{ lignes, total }, lecteurs, reglages] = await Promise.all([lireJournal(f), lecteursDuJournal(), getAppSettings()]);
  const pages = Math.max(1, Math.ceil(total / TAILLE_PAGE));
  const lien = (page: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) if (typeof v === "string" && v && k !== "page") q.set(k, v);
    q.set("page", String(page));
    return `?${q.toString()}`;
  };
  const val = (k: string) => (typeof searchParams[k] === "string" ? (searchParams[k] as string) : "");
  const champ = "h-9 rounded-md border bg-background px-2 text-sm";

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Accès aux données sensibles"
        description="Chaque lecture d'un RIB, d'un IBAN, d'un NIN ou d'un salaire par le coffre — accordée ou refusée — avec son auteur, son geste et la fiche concernée. Un modèle d'IA n'y a jamais accès : ses tentatives figurent ici, refusées."
      />
      {!reglages.coffreLecture && (
        <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
          La double lecture est fermée : les écrans lisent encore les colonnes, sans journal. Elle s&apos;ouvre depuis{" "}
          <Link className="underline" href="/admin/refonte-donnees">Refonte des données</Link>.
        </p>
      )}

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">Lecteur
          <select name="lecteur" defaultValue={val("lecteur")} className={champ}>
            <option value="">Tous</option>
            {lecteurs.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Fiche
          <select name="modele" defaultValue={val("modele")} className={champ}>
            <option value="">Toutes</option>
            {MODELES_SENSIBLES.map((m) => <option key={m} value={m}>{LIBELLE_MODELE[m]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Nature
          <select name="nature" defaultValue={val("nature")} className={champ}>
            <option value="">Toutes</option>
            {NATURES_COFFRE.map((n) => <option key={n} value={n}>{LIBELLE_NATURE[n]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Décision
          <select name="decision" defaultValue={val("decision")} className={champ}>
            <option value="">Toutes</option>
            <option value="accord">Accordées</option>
            <option value="refus">Refusées</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Du
          <input type="date" name="du" defaultValue={val("du")} className={champ} />
        </label>
        <label className="flex flex-col gap-1 text-xs">Au
          <input type="date" name="au" defaultValue={val("au")} className={champ} />
        </label>
        <Button type="submit" size="sm">Filtrer</Button>
        <Link href="/admin/acces-donnees-sensibles" className="text-sm text-muted-foreground underline">Effacer</Link>
      </form>

      {lignes.length === 0 ? (
        <EmptyState icon="ShieldCheck" title="Aucun accès" description="Aucune lecture du coffre ne correspond à ces filtres." />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{total} accès{pages > 1 ? ` — page ${f.page} / ${pages}` : ""}</p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quand</TableHead>
                  <TableHead>Qui</TableHead>
                  <TableHead>Geste</TableHead>
                  <TableHead>De qui</TableHead>
                  <TableHead>Donnée</TableHead>
                  <TableHead>Décision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lignes.map((l) => {
                  const c = l.modele && l.champ ? champSensible(l.modele, l.champ) : null;
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(l.le)}</TableCell>
                      <TableCell>{l.lecteur}</TableCell>
                      <TableCell className="max-w-xs break-words">{l.geste}</TableCell>
                      <TableCell>{l.titulaire}</TableCell>
                      <TableCell>{c?.libelle ?? (estNatureCoffre(l.nature) ? LIBELLE_NATURE[l.nature] : l.nature)}</TableCell>
                      <TableCell>
                        <Badge tone={l.autorise ? "success" : "danger"}>{l.autorise ? "Accordée" : "Refusée"}</Badge>{" "}
                        <span className="text-xs text-muted-foreground">{l.motif ? MOTIFS[l.motif] ?? l.motif : ""}</span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {pages > 1 && (
            <div className="flex gap-2">
              {f.page > 1 && <Link href={lien(f.page - 1)}><Button variant="outline" size="sm">Précédente</Button></Link>}
              {f.page < pages && <Link href={lien(f.page + 1)}><Button variant="outline" size="sm">Suivante</Button></Link>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
