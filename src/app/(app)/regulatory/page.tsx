import Link from "next/link";
import { AlertTriangle, Lock } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, anyRoleFilter, seesLockedRegulatory } from "@/lib/rbac";
import { canSetStructural } from "@/lib/regulatory/structural-fields";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { effectiveTherapeuticSegments } from "@/lib/labels";
import { RegulatoryTable } from "./regulatory-table";
import { getRegulatoryRows } from "@/lib/queries/regulatory-rows";
import { NewProductButton } from "./new-product";
import { MettreAuPipeline } from "./mettre-au-pipeline";
import { RangerDansLeDrive } from "./ranger-drive";
import { SuppliersManager } from "./suppliers-manager";
import { UpdateReminderButton } from "./update-reminder";
import { canSendUpdateReminder } from "@/lib/regulatory/update-reminder";
import { regulatoryReminderBoard } from "@/lib/queries/regulatory-reminders";
import { getBdProjectOptions } from "@/lib/queries/bd";

export default async function RegulatoryPage() {
  const user = await requireModule("REGULATORY");
  const canCreate = userCan(user, "REGULATORY", "CREATE");
  // Confier un dossier à quelqu'un, c'est le MODIFIER : même droit que l'édition de la fiche.
  const canAssign = userCan(user, "REGULATORY", "UPDATE");
  // Le cadenas n'appartient qu'au Super Admin — les autres ne voient même pas les dossiers verrouillés.
  const canLock = user.role === "SUPER_ADMIN";
  const { rows, products, suppliers, companies, settings, canSupervise } = await getRegulatoryRows(user);
  // LES PROJETS BD — le menu « Projet » du tableau. Même porte que le module Business
  // Development : sans accès, la liste est vide et la colonne retombe en texte.
  const bdProjects = await getBdProjectOptions(user);
  // LE VERROU, ET RIEN D'AUTRE, SÉPARE LES DEUX ÉCRANS. On filtrait sur l'étape « pipeline » :
  // or un dossier ABOUTI est classé « done » même verrouillé, et réapparaissait donc ici sous
  // l'onglet « Terminé » alors qu'il est censé vivre dans le pipeline. Le suivi des dossiers ne
  // montre QUE ce qui est ouvert à l'équipe ; tout ce qui est cadenassé est au pipeline.
  const visible = rows.filter((r) => !r.isLocked);

  // Personnes à qui un dossier peut être confié : l'équipe Regulatory + la Direction. Sert au
  // formulaire de création ET au menu déroulant « Chargé du dossier » du tableau.
  // LE RÔLE SECONDAIRE COMPTE. Quelqu'un à qui l'administration a donné « Assistante
  // réglementaire » en SECOND rôle fait le travail réglementaire — et n'apparaissait pourtant
  // pas dans la liste : on filtrait sur le rôle principal seul. `anyRoleFilter` regarde les
  // deux, comme partout ailleurs (notifications, portées).
  const assignableUsers = canCreate || canAssign
    ? await prisma.user.findMany({
        where: { isActive: true, ...anyRoleFilter(["HEAD_OF_REGULATORY", "REGULATORY_ASSISTANT", "DIRECTION"]) },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      })
    : [];

  // Liste détaillée des fournisseurs pour le gestionnaire (création / activation).
  const supplierList = canCreate
    ? await prisma.supplier.findMany({
        select: { id: true, name: true, country: true, contactEmail: true, active: true },
        orderBy: { name: "asc" },
      })
    : [];

  // Compté sur les dossiers RÉELLEMENT AFFICHÉS ici — pas sur tout le portefeuille. Le compte
  // incluait les dossiers verrouillés : cet écran annonçait donc « 12 dossiers sans entité » en
  // n'en montrant que quatre, et l'on cherchait les huit autres dans un tableau qui ne les
  // contient pas. Ceux du pipeline se signalent au pipeline.
  const visibleIds = new Set(visible.map((r) => r.id));
  const unassignedCount = products.filter((p) => !p.companyId && visibleIds.has(p.id)).length;
  // CE QUI N'EST PAS ICI, ET OÙ C'EST. Les deux écrans sont bien séparés — le verrou tranche —
  // mais rien ne le DISAIT : on comptait 84 dossiers dans le module et l'on en voyait 15, sans
  // savoir si les autres étaient perdus ou ailleurs. Une ligne suffit, et elle ne s'affiche
  // qu'à ceux qui ont accès au pipeline.
  const lockedCount = rows.length - visible.length;

  // LA RELANCE DE MISE À JOUR — réservée au Super Admin et au Directeur Général. Le tableau des
  // portefeuilles n'est chargé que pour eux : personne d'autre ne doit voir qui porte combien.
  const canRemind = canSendUpdateReminder(user);
  const reminderBoard = canRemind ? await regulatoryReminderBoard(user) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Regulatory"
        description="Suivi des molécules/DCI et de leur avancement réglementaire jusqu'à l'enregistrement."
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* UN SEUL CATALOGUE (Direction, 08/10) : chaque dossier EST un produit (Produits 360) ; plus
              d'écran de rattachement ici. Le rapprochement d'un produit BD / BU sans dossier vit dans
              Produits 360 (⋯). */}
          {reminderBoard && (
            <UpdateReminderButton
              people={reminderBoard.targets.map((t) => ({
                userId: t.userId, name: t.name, total: t.total, stale: t.stale,
                lastRemindedAt: t.lastRemindedAt?.toISOString() ?? null,
              }))}
              unassigned={reminderBoard.unassigned}
            />
          )}
          {/* Super Admin SEUL (Direction, 06/10) : remettre à l'étude tout ce qui n'a pas commencé. */}
          {user.role === "SUPER_ADMIN" && <MettreAuPipeline />}
          {/* Super Admin SEUL (Direction, 06/10) : chaque dossier du suivi rangé dans la catégorie Drive « Regulatory ». */}
          {user.role === "SUPER_ADMIN" && <RangerDansLeDrive />}
          {canCreate && (
            <>
              <SuppliersManager suppliers={supplierList} />
              <NewProductButton users={assignableUsers} suppliers={suppliers} companies={companies} />
            </>
          )}
        </div>
      </PageHeader>

      {/* Un dossier sans entité est visible de TOUT LE MONDE en vue « toutes les entités ».
          On ne le devine pas à sa place — on le signale, pour qu'un humain le rattache. */}
      {unassignedCount > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            <strong>{unassignedCount} dossier{unassignedCount > 1 ? "s" : ""} sans entité.</strong>{" "}
            L&apos;entité détermine qui a le droit de voir un dossier : tant qu&apos;elle n&apos;est pas
            renseignée, {unassignedCount > 1 ? "ces dossiers apparaissent" : "ce dossier apparaît"} à
            toute personne en vue « toutes les entités ». Ouvrez {unassignedCount > 1 ? "-les" : "-le"} et
            renseignez l&apos;entité.
          </span>
        </p>
      )}

      {canLock && lockedCount > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>{lockedCount} dossier{lockedCount > 1 ? "s" : ""} verrouillé{lockedCount > 1 ? "s" : ""}</strong>{" "}
            {lockedCount > 1 ? "ne figurent" : "ne figure"} pas ici : {lockedCount > 1 ? "ils vivent" : "il vit"} au
          </span>
          <Link href="/regulatory/pipeline" className="font-medium text-primary hover:underline">Pipeline</Link>
          <span>jusqu&apos;à l&apos;ouverture du cadenas.</span>
        </p>
      )}

      <RegulatoryTable
        rows={visible}
        canEditPriority={canSupervise}
        canAssign={canAssign}
        canSetStructural={canSetStructural(user)}
        canLock={canLock}
        assignableUsers={assignableUsers}
        companies={companies}
        segments={effectiveTherapeuticSegments(settings.regulatoryTherapeuticSegments)}
        projects={bdProjects}
        colonnesMasquees={settings.regulatoryHiddenColumns}
        // L'EXPORT PROPOSE L'AUTRE VOLET. Le suivi et le pipeline montrent les mêmes objets sous
        // deux angles ; exporter l'un sans proposer l'autre sortait la moitié du portefeuille
        // sans que rien ne le dise, et l'on recollait deux classeurs à la main. Le pipeline n'est
        // proposé qu'à qui a le droit de le voir : sinon l'option révélerait un compte de
        // dossiers verrouillés à quelqu'un qui n'en voit aucun.
        crossExport={
          seesLockedRegulatory(user) && rows.some((r) => r.isLocked)
            ? { label: "le pipeline", ids: rows.filter((r) => r.isLocked).map((r) => r.id) }
            : null
        }
      />
    </div>
  );
}
