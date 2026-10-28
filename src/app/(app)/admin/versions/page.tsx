import { redirect } from "next/navigation";
import { ArrowLeft, Rocket } from "lucide-react";
import { requireModule } from "@/lib/session";
import { listFeatures, isTestUser } from "@/lib/features";
import { PageHeader } from "@/components/shared/page-header";
import { VersionsManager } from "./versions-manager";
import { BackLink } from "@/components/shared/back-link";

export const metadata = { title: "Versions — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * Écran de VALIDATION des nouveautés : ce qui est en version de test, ce qui est en
 * production, et le bouton qui fait passer de l'un à l'autre. Réservé au Super Admin.
 */
export default async function VersionsPage() {
  const user = await requireModule("ADMIN");
  if (user.role !== "SUPER_ADMIN") redirect("/admin");

  const [rows, testMode] = await Promise.all([listFeatures(), isTestUser(user.id)]);

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Versions — test & production"
        description="Chaque nouveauté arrive d'abord en VERSION DE TEST : vous seul la voyez, tant que votre mode test est actif. Quand elle vous convient, vous la validez et elle passe en PRODUCTION pour toute l'entreprise. Le retour arrière est immédiat."
      />
      <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
        <Rocket className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p className="text-muted-foreground">
          <strong className="text-foreground">Comment ça marche :</strong> activez votre <strong>mode test</strong> ci-dessous,
          parcourez l&apos;application — vous verrez les nouveautés en test, personne d&apos;autre ne les voit.
          Puis cliquez sur <strong>« Valider en production »</strong> pour celles que vous voulez déployer.
        </p>
      </div>
      <VersionsManager rows={rows} testMode={testMode} />
    </div>
  );
}
