import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ongletsEspace } from "@/lib/queries/mes-taches";
import { listerMesRappels } from "@/lib/queries/reminders";
import { MyReminders } from "@/components/reminders/my-reminders";
import { RappelRapide } from "../rappel-rapide";

/**
 * TOUS MES RAPPELS (recette du 23/11/2026) — la page complète derrière l'encart « Mes rappels » de
 * « Mon espace » : les rappels personnels, ceux de l'assistant, les échéances et relances reçues, et
 * l'historique — sans plafond d'affichage. Les mêmes onglets et les mêmes gestes que l'encart.
 */
export default async function MesRappelsPage() {
  const user = await requireModule("WORKSPACE");
  const maintenant = new Date();
  const [rappels, tabs] = await Promise.all([listerMesRappels(user.id), ongletsEspace(user)]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Mes rappels"
        description="Vos rappels, ceux que l'assistant a posés pour vous, et les échéances et relances que la plateforme vous a envoyées ces 30 derniers jours."
      />
      <ModuleTabs tabs={tabs} />
      <Link href="/mon-espace" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
        <ArrowLeft className="h-3 w-3" aria-hidden /> Retour à Mon espace
      </Link>
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
          <MyReminders rappels={rappels} maintenant={maintenant.toISOString()} />
        </section>
        <aside className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Nouveau rappel</h2>
          <RappelRapide />
        </aside>
      </div>
    </div>
  );
}
