import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { REPRISES } from "@/lib/referentiels/reprises";
import { doubleEcritureLieuxActive } from "@/lib/lieux/rattachement-prisma";
import { CartesReprises, type CarteReprise } from "./cartes-reprises";
import { InterrupteurLieux } from "./interrupteur-lieux";

export const dynamic = "force-dynamic";
export const metadata = { title: "Refonte des données — AMD Internal OS" };

const MODULE = "Refonte des données";
const LIGNES_JOURNAL = 8;

/**
 * ADMINISTRATION › REFONTE DES DONNÉES (vague 2, `docs/architecture/refonte-vague-2.md`) — Super Admin seul.
 *
 * Une carte par reprise (`lib/referentiels/reprises`), dans l'ordre où les lancer : l'APERÇU compte à blanc, puis
 * on exécute LOT par lot ; chaque geste est au journal (`AuditLog`, module « Refonte des données ») et le dernier
 * lot dit où reprendre — la page relue après une interruption repart au bon curseur. Aucune reprise ne tourne au
 * déploiement : rien ne se passe tant que personne n'a cliqué ici.
 */
export default async function RefonteDonneesPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/mon-espace");

  const cles = REPRISES.map((r) => r.cle);
  const [journal, lieuxActif] = await Promise.all([
    prisma.auditLog.findMany({
      where: { module: MODULE, field: { in: cles } },
      orderBy: { createdAt: "desc" },
      take: 400,
      select: { id: true, action: true, field: true, newValue: true, summary: true, createdAt: true, actor: { select: { name: true } } },
    }),
    doubleEcritureLieuxActive(),
  ]);

  const cartes: CarteReprise[] = REPRISES.map((r) => {
    const lignes = journal.filter((j) => j.field === r.cle);
    // Le curseur où reprendre : celui du DERNIER lot exécuté (un aperçu ne déplace rien) ; nul = au début.
    const dernierLot = lignes.find((j) => j.action === "IMPORT");
    return {
      cle: r.cle,
      titre: r.titre,
      description: r.description,
      reprendreA: dernierLot?.newValue ?? null,
      journal: lignes.slice(0, LIGNES_JOURNAL).map((j) => ({
        id: j.id,
        quand: j.createdAt.toISOString(),
        qui: j.actor?.name ?? null,
        resume: j.summary ?? "",
      })),
    };
  });

  return (
    <div className="space-y-5">
      <BackLink href="/admin">Administration</BackLink>
      <PageHeader
        title="Refonte des données"
        description="Remplir les référentiels depuis l'existant, sans rien effacer : aperçu à blanc, puis exécution par lots, chaque geste journalisé. Rejouable."
      />
      <InterrupteurLieux actif={lieuxActif} />
      <CartesReprises cartes={cartes} />
    </div>
  );
}
