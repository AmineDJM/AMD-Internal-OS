import { userCan, type Module } from "@/lib/rbac";
import { getAdProRequests, getAdProCreateData, requireModuleOuAgences } from "@/modules/ad-pro/api";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { creatableKinds } from "@/modules/ad-pro/partage";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { EVENTS_TABS } from "@/lib/labels";
import { AdProList } from "./ad-pro-list";
import { lignesPourLaListe } from "./attente";
import { NewRequestPicker } from "./new-request-picker";

export const dynamic = "force-dynamic";

/**
 * AD & PRO — UNE SEULE DEMANDE, UNE SEULE LISTE.
 *
 * Sponsoring, prises en charge, événements, matériel promotionnel : pour celui qui demande, ce
 * sont cinq façons de poser la même question — « je veux engager une dépense de promotion ». Lui
 * faire choisir le bon écran AVANT de pouvoir formuler son besoin, c'est lui demander de connaître
 * notre découpage interne. Ici il décrit ce qu'il veut faire, et l'outil l'emmène au bon endroit.
 *
 * Les circuits, eux, restent distincts : un congrès international a des billets et des visas qu'un
 * sponsoring n'a pas. On unifie l'ENTRÉE et la LECTURE, pas le stockage — chaque nature garde son
 * écran, maître de ses champs propres et de son circuit de validation.
 *
 * L'entrée est unifiée JUSQU'AU BOUT : le formulaire de la nature choisie s'ouvre ici, dans le
 * panneau commun. Renvoyer vers l'écran du module rendait au demandeur, au dernier moment, le
 * découpage interne qu'on venait de lui épargner.
 *
 * L'ÉCRAN EST UN TABLEAU, SANS PHRASE (Super Admin, 24/11/2026) : le titre, « Nouvelle demande », les onglets du
 * pôle, puis la liste. Les tuiles-compteurs d'en-tête sont devenues les pastilles d'état du tableau — le même
 * chiffre, cliquable, et qui suit la recherche.
 */
export default async function AdProPage() {
  // La porte d'entrée du pôle : le Sponsoring suffit à l'ouvrir, la liste s'adapte ensuite aux
  // modules réellement accessibles.
  const user = await requireModuleOuAgences("SPONSORING");

  // Créer et consulter ne sont pas le même droit : le panneau ne propose que les natures qui
  // aboutiront, la liste des écrans détaillés suit les modules simplement accessibles.
  const kinds = creatableKinds((m) => userCan(user, m as Module, "CREATE"));
  const [rows, createData, tabs] = await Promise.all([
    getAdProRequests(user),
    getAdProCreateData(user.id, kinds.map((k) => k.kind)),
    visibleTabs(user, EVENTS_TABS),
  ]);
  // Chez qui en est chaque demande, depuis quand, et ce qui attend la personne qui regarde : lu à côté de la liste,
  // sans la changer (`attente.ts`).
  const lignes = await lignesPourLaListe(user, rows);

  return (
    <div className="space-y-5">
      <PageHeader title="Ad & Pro">
        <NewRequestPicker
          kinds={kinds}
          data={createData}
        />
      </PageHeader>

      {/* LA BARRE D'ONGLETS DU PÔLE — c'est ICI que mène le menu « Ad & Pro ». Elle manquait sur
          cette seule page : le Stock et le Catalogue promotionnels, qui ne sont pas des natures de
          demande et n'ont donc aucune autre porte, étaient introuvables depuis le menu — tous les
          autres écrans du pôle la portaient, celui par lequel on entre ne la portait pas (§118.169).
          `onglets-porte.test.ts` l'exige de toute entrée de menu à onglets. */}
      <ModuleTabs tabs={tabs} />

      {rows.length === 0 ? (
        <EmptyState
          icon="PartyPopper"
          title="Aucune demande pour l'instant"
          description={kinds.length > 0 ? "« Nouvelle demande » en dépose une." : undefined}
        />
      ) : (
        <AdProList rows={lignes} maintenant={Date.now()} />
      )}
    </div>
  );
}
