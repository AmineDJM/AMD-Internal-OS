import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { REPRISES } from "@/lib/referentiels/reprises";
import { MODULE_JOURNAL_REPRISES } from "@/lib/referentiels/reprises/journal";
import { CarteReprise, type EntreeJournal } from "./carte-reprise";
import { InterrupteurDoubleEcriture } from "./interrupteur-double-ecriture";

export const dynamic = "force-dynamic";
export const metadata = { title: "Refonte des données — AMD Internal OS" };

/**
 * ADMINISTRATION › REFONTE DES DONNÉES (vague 2 — `docs/architecture/refonte-vague-2.md`), Super Admin seul.
 *
 * Une carte par reprise du registre : ce qu'elle fait, l'aperçu à blanc, l'exécution par lots, et son journal
 * (les dernières entrées de l'audit). Puis les interrupteurs de double écriture. Rien ne tourne tout seul : ce
 * qui est rempli ici l'a été par un geste du Super Admin, et le journal dit lequel.
 */
export default async function RefonteDonneesPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");

  const [journal, reglages, personnes, doublons] = await Promise.all([
    prisma.auditLog.findMany({
      where: { module: MODULE_JOURNAL_REPRISES, field: { in: REPRISES.map((r) => r.cle) } },
      orderBy: { createdAt: "desc" }, take: 200,
      select: { id: true, field: true, summary: true, createdAt: true, actor: { select: { name: true } } },
    }),
    prisma.appSetting.findUnique({ where: { id: "global" }, select: { refontePersonnesDoubleEcriture: true } }),
    prisma.personne.count({ where: { fusionneeDansId: null } }),
    prisma.doublonPersonne.count({ where: { statut: "PROPOSE" } }),
  ]);
  const journalDe = (cle: string): EntreeJournal[] =>
    journal.filter((j) => j.field === cle).slice(0, 6).map((j) => ({ id: j.id, quand: j.createdAt.toISOString(), qui: j.actor?.name ?? "—", resume: j.summary ?? "" }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Refonte des données"
        description="Remplir les référentiels depuis l'existant : aperçu à blanc d'abord, puis lot par lot. Rejouable sans effet de bord ; rien ne tourne tout seul au déploiement."
      />

      <section className="surface space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Personnes (R1)</h2>
          <p className="text-sm text-muted-foreground">
            {personnes} Personne(s) · <Link href="/personnes/doublons" className="text-primary underline">{doublons} doublon(s) à trancher</Link>
          </p>
        </div>
        <InterrupteurDoubleEcriture actif={reglages?.refontePersonnesDoubleEcriture === true} />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {REPRISES.map((r) => (
          <CarteReprise key={r.cle} cle={r.cle} titre={r.titre} description={r.description} journal={journalDe(r.cle)} />
        ))}
      </div>
    </div>
  );
}
