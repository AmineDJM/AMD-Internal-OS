import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { prisma } from "@/lib/prisma";
import { getMarketResearch, listResearchPresentations, nomenclatureDciOptions } from "@/lib/queries/market-research";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResearchTable } from "../research-table";
import { ResearchMeta } from "./research-meta";
import { PresentationPanel } from "../presentation-panel";

export const dynamic = "force-dynamic";

export default async function MarketResearchDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("BUSINESS_DEVELOPMENT");
  const canEdit = userCan(user, "BUSINESS_DEVELOPMENT", "UPDATE");
  const research = await getMarketResearch(params.id);
  if (!research) notFound();
  const presentations = await listResearchPresentations(research.id);
  const dciOptions = nomenclatureDciOptions();
  const allUsers = canEdit
    ? await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];

  return (
    <div className="space-y-5">
      <PageHeader title={research.title} description="Analyse concurrentielle : taille de marché, prix moyen, acteurs et parts de marché — éditable en place.">
        <Link href="/business-development/etudes"><Button variant="outline"><ArrowLeft className="h-4 w-4" /> Études</Button></Link>
        <a href={`/api/market-research/${research.id}/export`}><Button variant="outline"><FileSpreadsheet className="h-4 w-4" /> Export Excel</Button></a>
      </PageHeader>

      <Card>
        <CardHeader><CardTitle>Étude — sources, participants & nom</CardTitle></CardHeader>
        <CardContent>
          <ResearchMeta research={research} allUsers={allUsers} canEdit={canEdit} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <ResearchTable researchId={research.id} rows={research.rows} canEdit={canEdit} dciOptions={dciOptions} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <PresentationPanel researchId={research.id} presentations={presentations} canEdit={canEdit} aiConfigured={aiConfigured()} cleIa={cleModeleRequise()} rowCount={research.rows.length} />
        </CardContent>
      </Card>
    </div>
  );
}
