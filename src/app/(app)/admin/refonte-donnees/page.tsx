import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { REPRISES } from "@/lib/referentiels/reprises";
import { etatFile } from "@/lib/enrichissement/lectures";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CarteReprise } from "./carte-reprise";
import { PanneauEnrichissement } from "./panneau-enrichissement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Refonte des données — Administration" };

/**
 * L'ÉCRAN UNIQUE DE LA REFONTE DES DONNÉES (vague 2) — Super Admin seul. Une carte par reprise (aperçu
 * à blanc, exécution par lots, journal), et l'interrupteur de l'enrichissement des fiches avec l'état de
 * sa file. Rien ne tourne au déploiement : tout part d'ici.
 */
export default async function RefonteDonneesPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") notFound();
  const etat = await etatFile();
  return (
    <div className="space-y-6">
      <PageHeader title="Refonte des données" description="Reprises des référentiels et enrichissement des fiches par les pièces déposées — lancés à la main, rejouables, journalisés.">
        <Link href="/admin" className="text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 inline h-4 w-4" />Administration</Link>
      </PageHeader>

      <PanneauEnrichissement etat={etat} />

      <Card>
        <CardHeader><CardTitle>Reprises</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {REPRISES.map((r) => <CarteReprise key={r.cle} cle={r.cle} titre={r.titre} description={r.description} />)}
        </CardContent>
      </Card>
    </div>
  );
}
