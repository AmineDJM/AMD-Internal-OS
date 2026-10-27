import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { REPRISES } from "@/lib/referentiels/reprises";
import { couvertureDuCoffre } from "@/lib/coffre/couverture";
import { LIBELLE_MODELE } from "@/lib/coffre/champs";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { CarteReprise } from "./carte-reprise";
import { InterrupteursCoffre } from "./interrupteurs-coffre";

export const dynamic = "force-dynamic";

/**
 * ADMINISTRATION › REFONTE DES DONNÉES — Super Admin seul (`docs/architecture/refonte-vague-2.md`).
 *
 * Une carte par reprise : aperçu à blanc, exécution par lots, journal (les audits « Refonte des données »). La carte du
 * coffre porte en plus ses deux interrupteurs et sa couverture colonne par colonne. Rien ne tourne au
 * déploiement : tout part d'ici.
 */
export default async function RefonteDonneesPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/mon-espace");

  const [journal, reglages, couverture] = await Promise.all([
    prisma.auditLog.findMany({
      where: { module: "Refonte des données" },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, field: true, summary: true, createdAt: true, actor: { select: { name: true } } },
    }),
    getAppSettings(),
    couvertureDuCoffre(),
  ]);

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Refonte des données"
        description="Les reprises de la vague 2 remplissent les référentiels depuis l'existant. Commencez par l'aperçu à blanc (rien n'est écrit), puis exécutez par lots ; une reprise se rejoue sans rien recréer. Aucune colonne historique n'est effacée."
      />

      {REPRISES.map((r) => {
        const lignes = journal.filter((j) => j.field === `reprise:${r.cle}`).slice(0, 10);
        return (
          <Card key={r.cle}>
            <CardHeader>
              <CardTitle>{r.titre}</CardTitle>
              <p className="text-sm text-muted-foreground">{r.description}</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {r.cle === "coffre" && (
                <>
                  <InterrupteursCoffre ecriture={reglages.coffreEcriture} lecture={reglages.coffreLecture} />
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Colonne</TableHead>
                          <TableHead className="text-right">En clair</TableHead>
                          <TableHead className="text-right">Copiées au coffre</TableHead>
                          <TableHead className="text-right">Rattachées à leur fiche</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {couverture.map((c) => (
                          <TableRow key={`${c.champ.modele}.${c.champ.champ}`}>
                            <TableCell>
                              {c.champ.libelle} <span className="text-xs text-muted-foreground">({LIBELLE_MODELE[c.champ.modele]})</span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{c.enClair}</TableCell>
                            <TableCell className={`text-right tabular-nums ${c.copiees < c.enClair ? "text-warning" : ""}`}>{c.copiees}</TableCell>
                            <TableCell className="text-right tabular-nums">{c.rattachees}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Ordre conseillé : ouvrir la double écriture, exécuter la reprise jusqu&apos;au bout (les valeurs mal formées sont listées, à corriger sur leur fiche), puis ouvrir la double lecture.
                    Qui a lu quoi : <Link className="underline" href="/admin/acces-donnees-sensibles">Accès aux données sensibles</Link>.
                  </p>
                </>
              )}
              <CarteReprise cle={r.cle} />
              {lignes.length > 0 && (
                <div>
                  <p className="mb-1 text-sm font-medium">Journal</p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {lignes.map((j) => (
                      <li key={j.id}>{formatDateTime(j.createdAt)} — {j.actor?.name ?? "?"} — {j.summary}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {journal.some((j) => j.field?.startsWith("coffre")) && (
        <Card>
          <CardHeader><CardTitle>Interrupteurs — historique</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {journal.filter((j) => j.field?.startsWith("coffre")).slice(0, 10).map((j) => (
                <li key={j.id}>{formatDateTime(j.createdAt)} — {j.actor?.name ?? "?"} — {j.summary}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
