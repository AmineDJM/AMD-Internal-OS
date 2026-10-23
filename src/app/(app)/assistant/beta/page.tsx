import { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { AssistantWorkspace } from "@/components/assistant-beta/assistant-workspace";

export const metadata: Metadata = {
  title: "Assistant IA Beta — Adventum Pharma",
  description: "Espace conversationnel augmenté sous Human Interface Guidelines et décor serein.",
};

export const dynamic = "force-dynamic";

export default async function AssistantBetaPage() {
  const user = await requireUser();

  const [nbUsers, nbDossiers, nbProduits, nbTaches] = await Promise.all([
    prisma.user.count(),
    prisma.regulatoryDossier.count(),
    prisma.product.count(),
    prisma.task.count(),
  ]);

  const initialKpiData = {
    nbUsers,
    nbDossiers,
    nbProduits,
    nbTaches,
    userName: user.name,
    userRole: user.role,
  };

  return <AssistantWorkspace initialKpiData={initialKpiData} />;
}
